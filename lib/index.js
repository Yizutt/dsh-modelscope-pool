// dsh-go 原生插件：魔搭（ModelScope）多 Key 聚合网关。
// 界面只用于看状态和点按，Key 只存在本机文件里，不出现在视图、日志或响应头里。
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createCatalog } from './catalog.js'
import { KeyPool, maskKey, nextQuotaResetAt } from './pool.js'
import { registerPoolProvider, isChatModel } from './provider.js'
import { createProxy, quotaLike } from './proxy.js'
import { createQuotaBook, REGIONS } from './quota.js'
import { createRouter } from './route.js'

export const name = 'local-modelscope-pool'

// 「模型」页只有在这个插件的设置命名空间存在时才显示「魔搭 Key 池」这一行，
// 而命名空间来自这里导出的 Config schema，键就是 loader 里的条目 id。
const HOST_ROOTS = [join(homeDir(), 'profiles', 'web'), '/opt/dsh']
const z = (() => {
  for (const root of HOST_ROOTS) {
    try {
      const load = createRequire(join(root, 'noop.cjs'))
      return load('@deepseek-ai/schemastery')
    } catch {}
  }
  return undefined
})()

const asVolatile = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema)

// 设置服务只把 volatile 字段投影成可编辑表单；没有 volatile 字段的命名空间会被整条跳过，
// 「模型」页也就看不到这个供应商。
export const Config = z
  ? z.object({
      note: asVolatile(
        z
          .string()
          .default('')
          .description('这里的模型来自本机多 Key 网关；Key、额度与默认模型在对话详情 ›「插件」里的「魔搭 Key 池」面板管理。'),
      ),
    })
  : undefined

const DEFAULTS = {
  port: 8899,
  cooldownMs: 5 * 60_000,
  timeoutMs: 120_000,
  upstream: 'https://api-inference.modelscope.ai/v1',
  // 备用线路：主线路连不上时自动换，客户端无感。
  upstreams: [],
  apiKey: '',
  model: '',
}

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

async function loadConfig(dir) {
  const file = join(dir, 'config.json')
  let config = { ...DEFAULTS }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if (raw && typeof raw === 'object') config = { ...config, ...raw }
  } catch {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 }).catch(() => {})
  }
  config.port = Number(config.port) || DEFAULTS.port
  config.upstreams = Array.isArray(config.upstreams)
    ? config.upstreams.map((u) => String(u ?? '').trim()).filter((u) => /^https?:\/\//.test(u)).slice(0, 4)
    : []
  config.cooldownMs = Math.max(30_000, Number(config.cooldownMs) || DEFAULTS.cooldownMs)
  config.timeoutMs = Math.max(5_000, Number(config.timeoutMs) || DEFAULTS.timeoutMs)
  return config
}

async function saveConfig(dir, config) {
  try {
    const body = JSON.stringify(
      {
        port: config.port,
        cooldownMs: config.cooldownMs,
        timeoutMs: config.timeoutMs,
        upstream: config.upstream,
        upstreams: config.upstreams,
        apiKey: config.apiKey,
        model: config.model ?? '',
      },
      null,
      2,
    )
    await writeFile(join(dir, 'config.json'), body + '\n', { mode: 0o600 })
    await chmod(join(dir, 'config.json'), 0o600).catch(() => {})
  } catch (error) {
    return String(error?.message ?? error)
  }
  return ''
}

const fmtLeft = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (total >= 3600) return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 北京时间 HH:MM，用来显示「冷却至 00:01」这种按天恢复的 Key。 */
const fmtCN = (ms) => {
  if (!ms) return ''
  const d = new Date(Number(ms) + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function apply(ctx) {
  // 诊断：cordis 是否真的把本模块的 Config 挂在 fiber.runtime 上（设置命名空间靠它）。
  try {
    const fiber = ctx?.fiber
    const rt = fiber?.runtime
    globalThis.__poolRuntimeProbe = {
      hasFiber: Boolean(fiber),
      hasRuntime: Boolean(rt),
      runtimeKeys: rt ? Object.keys(rt) : null,
      runtimeConfig: typeof rt?.Config,
      callbackConfig: typeof rt?.callback?.Config,
      hasToJSON: typeof rt?.Config?.toJSON,
    }
  } catch {}
  const dir = join(homeDir(), 'modelscope-pool')
  const logger = ctx.logger
  let pool
  let proxy
  let config = { ...DEFAULTS }
  let quota
  let catalog
  let providerState = { registered: false, models: 0, error: '' }
  let markStarted = () => {}
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  let refreshPanel = () => {}
  let refreshStrip = () => {}
  // Key 级无感路由：模型不变，只换 Key。
  const router = createRouter({ logger })

  const ready = (async () => {
    config = await loadConfig(dir)
    pool = new KeyPool({ dir, cooldownMs: config.cooldownMs, logger })
    await pool.init()
    quota = createQuotaBook({ logger })
    catalog = createCatalog({ regions: REGIONS })
  })()

  /** 魔粒低于这个数就别再用了：一次 deepseek 请求就要 1～2 个魔粒，剩 0/1 必然 429。 */
  const QUOTA_FLOOR = 2
  /** 正在复查额度的 Key，避免同一个 Key 被多次 429 时重复排队。 */
  const requeueing = new Map()

  /** 按额度落地 Key 状态：够用就恢复，低于下限就停到次日 00:01。 */
  const applyQuota = (id, state) => {
    if (!pool || !state?.ok) return
    const entry = pool.keys.find((k) => k.id === id)
    const st = entry && pool.states.get(id)
    if (!st) return
    if (state.available < QUOTA_FLOOR) {
      const untilAt = nextQuotaResetAt()
      if (st.until !== untilAt || st.lastReason !== '额度不足') {
        pool.markFailure(id, '额度不足', `剩余 ${state.available} 魔粒`, untilAt)
      }
    } else if (st.lastReason === '额度不足' || st.lastReason === '额度用尽') {
      // 额度又回来了（充值 / 跨天 / 之前是误判），放回池子。
      pool.restore(id)
    }
  }

  const sweepQuotaFloor = () => {
    if (!pool || !quota) return
    for (const k of pool.keys) {
      const state = quota.cached(k.id)
      if (state?.ok) applyQuota(k.id, state)
    }
    refreshPanel()
    refreshStrip()
  }

  /** 某个 Key 出现 429 后：一直重查它的额度，查到为止（约 5 分钟窗口）。 */
  const requeueQuota = (id, secret) => {
    if (!quota || !secret) return Promise.resolve()
    if (requeueing.has(id)) return requeueing.get(id)
    const job = (async () => {
      const delays = [0, 5_000, 10_000, 20_000, 40_000, 60_000, 90_000, 120_000]
      for (const wait of delays) {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        const state = await quota.refreshOne(id, secret, { force: true })
        if (state?.ok) {
          if (state.region) await pool.setRegion(id, state.region)
          applyQuota(id, state)
          const st = pool?.states.get(id)
          if (!st || st.until === 0) {
            logger?.info?.(`modelscope-pool: key ${id} 额度已查明（剩余 ${state.available} 魔粒）`)
            refreshPanel()
            refreshStrip()
            return
          }
          // 查到了但确实不够：按额度停用，不必再重试。
          logger?.warn?.(`modelscope-pool: key ${id} 额度不足（剩余 ${state.available} 魔粒），停用到次日 00:01`)
          refreshPanel()
          refreshStrip()
          return
        }
      }
      logger?.warn?.(`modelscope-pool: key ${id} 额度一直查不出来，维持冷却`)
    })().finally(() => requeueing.delete(id))
    requeueing.set(id, job)
    return job
  }

  /**
   * 认出的版本写回 keys.json（只写变化的，避免每次刷新都落盘）。
   * 版本判定就是「哪个站点的额度接口认这个令牌」，顺便把额度也查了。
   */
  const persistRegions = async (ids) => {
    if (!pool || !quota) return
    for (const id of ids ?? pool.keys.map((k) => k.id)) {
      const state = quota.cached(id)
      const region = state?.region
      if (region) await pool.setRegion(id, region)
    }
  }

  /** 额度/模型目录的后台刷新：不阻塞界面，也不用每次重绘都联网。 */
  const refreshQuota = (force = false) => {
    if (!pool || !quota) return Promise.resolve()
    const entries = pool.keys.map((k) => ({ id: k.id, key: k.key, region: k.region }))
    if (entries.length === 0) return Promise.resolve()
    return quota
      .refresh(entries, { force })
      .then(() => persistRegions())
      .then(() => {
        sweepQuotaFloor()
      })
  }
  const refreshCatalog = (force = false) => {
    if (!pool || !catalog) return Promise.resolve()
    return catalog.list({ force }).then(() => {
      refreshPanel()
    })
  }
  const selectModel = async (model) => {
    const next = String(model ?? '').trim()
    if (!next || next.length > 120) return false
    config.model = next
    await saveConfig(dir, config)
    refreshPanel()
    refreshStrip()
    return true
  }

  const endpoint = () => (proxy?.port ? `http://127.0.0.1:${proxy.port}/v1` : '网关未启动')

  // 面板上的「选中某个 Key / 翻页」是纯前端状态，放在闭包里，刷新视图时保留。
  let keyFocus = ''
  let keyPage = 0
  let deleteArmed = ''
  const KEYS_PER_PAGE = 40
  const pickedKey = () => (keyFocus && pool?.keys.some((k) => k.id === keyFocus) ? keyFocus : '')


  /** 模型行的显示：短名当标题，真实 id 当副标题，点了设为默认。 */
  const modelRowOf = (entry, current) => {
    const id = String(entry?.id ?? '')
    const isCurrent = id === current
    const regions = entry?.regions ?? []
    const where = regions.length > 1 ? '国际版 + 国内版' : REGIONS[regions[0]]?.label ?? '站点未知'
    return {
      title: entry?.name || id,
      subtitle: isCurrent ? `当前默认 · ${where}` : where,
      trailing: isCurrent ? '当前' : '使用',
      icon: isCurrent ? 'check' : 'model',
      tone: isCurrent ? 'good' : undefined,
      action: { id: 'pick-model', args: { model: id } },
    }
  }

  function buildData() {
    const s = pool ? pool.status() : { total: 0, available: 0, cooling: 0, keys: [], stats: { requests: 0 } }
    const ids = s.keys.map((k) => k.id)
    const q = quota ? quota.sum(ids) : { available: 0, known: 0 }
    const model = String(config.model ?? '')
    const modelEntry = catalog?.resolve(model)
    const currentModel = modelEntry?.id ?? model
    const models = (catalog?.entries ?? []).filter((entry) => isChatModel(entry.id))
    const routing = router.snapshot()
    const routed = routing.blockedPairs > 0 ? `已记下 ${routing.blockedPairs} 个「Key×模型」的失败组合（5 分钟内自动跳过）。` : ''
    const hint =
      s.total === 0
        ? '还没有 Key：在魔搭复制令牌（ms- 开头）后点输入框上方的「添加 Key」，也可以在下面直接填。'
        : s.cooling > 0
          ? `无感切换已开：剩余魔粒低于 2 的 Key 已自动停用到次日 00:01，避免撞 429。到点自动恢复。${routed}`
          : model
            ? `无感切换已开：模型始终是 ${model}，Key 遇到限流、额度不足、没权限会自动换下一个；魔粒低于 2 的 Key 会提前停用。${routed}`
            : `点「刷新额度」看剩余魔粒；点下面的模型可以设为默认。${routed}`
    // 扇形图：Key 池的状态分布（可用 / 额度不足 / 令牌无效 / 其他冷却）
    const buckets = { 可用: 0, 额度不足: 0, 令牌无效: 0, '其他冷却': 0 }
    for (const k of s.keys) {
      if (k.state === 'ok') buckets['可用']++
      else if (k.reason === '额度不足' || k.reason === '额度用尽') buckets['额度不足']++
      else if (k.reason === '令牌无效') buckets['令牌无效']++
      else buckets['其他冷却']++
    }
    const shareCategories = Object.keys(buckets).filter((name) => buckets[name] > 0)
    const shareValues = shareCategories.map((name) => buckets[name])
    const share = {
      kind: 'donut',
      categories: shareCategories,
      series: [{ name: 'Key', values: shareValues }],
      unit: '个',
      caption:
        s.total === 0
          ? '还没有 Key'
          : `共 ${s.total} 个 Key：可用 ${buckets['可用']}，额度不足 ${buckets['额度不足']}，其余冷却中`,
    }

    const pageCount = Math.max(1, Math.ceil(s.total / KEYS_PER_PAGE))
    keyPage = Math.min(Math.max(0, keyPage), pageCount - 1)
    const pageNo = keyPage + 1
    const pageKeys = s.keys.slice(keyPage * KEYS_PER_PAGE, keyPage * KEYS_PER_PAGE + KEYS_PER_PAGE)

    // 单个 Key 的详情（完整令牌只在本机面板显示，日志/响应头里永远只有掩码）。
    const focusRow = keyFocus ? s.keys.find((k) => k.id === keyFocus) : undefined
    const focusRaw = keyFocus ? pool.keys.find((k) => k.id === keyFocus) : undefined
    const focusState = focusRow ? quota?.cached(focusRow.id) : undefined
    const focusData = focusRow
      ? {
          title: `${focusRow.id} · ${focusRow.masked}`,
          rows: [
            ['完整令牌', focusRaw?.key ?? '—'],
            ['版本', REGIONS[focusRow.region]?.label ?? '版本未知'],
            [
              '额度',
              focusState?.ok
                ? `${focusState.available} 魔粒（总额 ${focusState.total}，冻结 ${focusState.frozen}）`
                : focusState
                  ? `查询失败：${focusState.error}`
                  : '还没查过',
            ],
            [
              '状态',
              focusRow.state === 'ok'
                ? '可用'
                : focusRow.manual
                  ? `已禁用（点「恢复」放开）`
                  : `${focusRow.reason || '冷却中'}${focusRow.untilAt ? ` · 冷却至 ${fmtCN(focusRow.untilAt)}` : ''}`,
            ],
            ['失败', `${focusRow.fails} 次 · ${focusRow.lastError || '无'}${focusRow.used ? ` · 用过 ${focusRow.used} 次` : ''}`],
          ],
          hint: '「禁用」= 一直停到点恢复；「停用」= 停到北京时间次日 00:01；「删除」会把令牌从本机文件里去掉。',
        }
      : { title: '还没选中 Key（回「Key 列表」点一行）', rows: [], hint: '' }

    // 模型列表按站点分组：国际版 → 国内版 → 双站，名字用短名。
    const modelRows = []
    const modelOrder = ['ai', 'cn']
    for (const region of modelOrder) {
      const group = models.filter((entry) => entry.regions?.length === 1 && entry.regions[0] === region)
      if (group.length === 0) continue
      modelRows.push({ title: REGIONS[region]?.label ?? region, icon: 'globe', tone: 'info', subtitle: `${group.length} 个模型` })
      for (const entry of group) modelRows.push(modelRowOf(entry, currentModel))
    }
    const both = models.filter((entry) => (entry.regions?.length ?? 0) > 1)
    if (both.length > 0) {
      modelRows.push({ title: '国际版 + 国内版都有', icon: 'globe', tone: 'info', subtitle: `${both.length} 个模型` })
      for (const entry of both) modelRows.push(modelRowOf(entry, currentModel))
    }
    const unknownRegion = models.filter((entry) => (entry.regions?.length ?? 0) === 0)
    if (unknownRegion.length > 0) {
      modelRows.push({ title: '站点未知', icon: 'globe', tone: 'info', subtitle: `${unknownRegion.length} 个模型` })
      for (const entry of unknownRegion) modelRows.push(modelRowOf(entry, currentModel))
    }

    return {
      available: s.available,
      cooling: s.cooling,
      share,
      magicubes: q.known > 0 ? String(q.available) : '—',
      endpoint: endpoint(),
      hint,
      modelTitle:
        models.length === 0
          ? '模型（还没读到，点下面「重新拉取模型」）'
          : `${models.length} 个模型 · 当前 ${modelEntry?.name ?? (model || '未选')}`,
      keyTitle:
        s.total === 0
          ? 'Key 池（还没有 Key）'
          : `Key 池 ${s.total} 个 · 第 ${pageNo}/${pageCount} 页（点一行看详情）`,
      keyPager: s.total > KEYS_PER_PAGE ? `第 ${pageNo}/${pageCount} 页 · 每页 ${KEYS_PER_PAGE} 个` : '',
      keys: pageKeys.map((k) => {
        const state = quota?.cached(k.id)
        const used = `用过 ${k.used} 次`
        const money = state?.ok ? `额度 ${state.available} 魔粒` : state && !state.ok ? `额度未知（${state.error.slice(0, 24)}）` : '额度未查'
        const region = REGIONS[k.region]?.label ?? '版本未知'
        return {
          title: `${k.id} · ${k.masked}${k.id === keyFocus ? '（已选中）' : ''}`,
          subtitle: k.reason
            ? `${k.reason}（失败 ${k.fails} 次）· ${money} · ${region}`
            : `${money} · ${region} · ${used}`,
          trailing:
            k.state === 'ok'
              ? '可用'
              : k.manual
                ? '已禁用'
                : k.untilAt
                  ? `冷却至 ${fmtCN(k.untilAt)}`
                  : `冷却 ${fmtLeft(k.leftMs)}`,
          icon: k.state === 'ok' ? 'cloud' : k.manual ? 'remove' : 'time',
          tone: k.state === 'ok' ? 'good' : k.manual ? 'bad' : 'warn',
          action: { id: 'key-open', args: { id: k.id } },
        }
      }),
      focus: focusData,
      models: modelRows,
    }
  }

  const viewPool = {
    v: 2,
    type: 'stack',
    title: '魔搭 Key 池',
    accent: 'teal',
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: '可用', value: { $: 'data.available' }, tone: 'good' },
          { type: 'metric', label: '冷却', value: { $: 'data.cooling' }, tone: 'warn' },
          { type: 'metric', label: '魔粒', value: { $: 'data.magicubes' }, tone: 'info' },
        ],
      },
      {
        type: 'chart',
        kind: 'donut',
        categories: { $: 'data.share.categories' },
        series: { $: 'data.share.series' },
        caption: { $: 'data.share.caption' },
      },
      { type: 'callout', tone: 'info', text: { $: 'data.hint' } },
      { type: 'text', text: { $: 'data.keyTitle' }, style: { size: 'title', weight: 'bold' } },
      { type: 'list', items: { $: 'data.keys' } },
      {
        type: 'actions',
        items: [
          { label: '上一页', icon: 'collapse', action: { id: 'key-prev' } },
          { label: '下一页', icon: 'expand', action: { id: 'key-next' } },
        ],
      },
      {
        type: 'actions',
        items: [
          { label: '刷新额度', icon: 'refresh', action: { id: 'refresh' } },
          { label: '测试全部', icon: 'bolt', action: { id: 'test-all' } },
          { label: '全部恢复', icon: 'play', action: { id: 'restore-all' } },
        ],
      },
      { type: 'text', text: { $: 'data.focusTitle' }, tone: 'muted' },
      {
        type: 'form',
        submitLabel: '添加',
        submit: 'add-form',
        children: [{ type: 'textField', label: '添加 Key', bind: 'data.newKey', placeholder: '粘贴 ms- 开头的令牌，可多行' }],
      },
    ],
  }

  const viewKey = {
    v: 2,
    type: 'stack',
    title: 'Key 详情',
    children: [
      { type: 'text', text: { $: 'data.title' }, style: { size: 'title', weight: 'bold' } },
      { type: 'keyValue', items: { $: 'data.rows' } },
      {
        type: 'actions',
        items: [
          { label: '禁用', icon: 'remove', action: { id: 'key-disable' } },
          { label: '停用', icon: 'clock', action: { id: 'key-stop' } },
          { label: '恢复', icon: 'play', action: { id: 'key-restore' } },
          { label: '删除', icon: 'delete', action: { id: 'key-delete' } },
        ],
      },
      { type: 'callout', tone: 'warn', text: { $: 'data.hint' } },
      { type: 'actions', items: [{ label: '返回 Key 列表', icon: 'list', action: { id: 'key-back' } }] },
    ],
  }

  const viewModels = {
    v: 2,
    type: 'stack',
    title: '魔搭模型',
    children: [
      { type: 'text', text: { $: 'data.modelTitle' }, style: { size: 'title', weight: 'bold' } },
      { type: 'list', items: { $: 'data.models' } },
      { type: 'actions', items: [{ label: '重新拉取模型', icon: 'refresh', action: { id: 'refresh-models' } }] },
    ],
  }

  const buildPoolData = () => {
    const d = buildData()
    return {
      available: d.available,
      cooling: d.cooling,
      magicubes: d.magicubes,
      share: d.share,
      hint: d.hint,
      keyTitle: d.keyTitle,
      keys: d.keys,
      focusTitle: d.focus.title,
    }
  }
  const buildKeyData = () => {
    const d = buildData()
    return { title: d.focus.title, rows: d.focus.rows, hint: d.focus.hint || '回到「魔搭 Key 池」面板，点列表里任意一行就会选中它。' }
  }
  const buildModelsData = () => {
    const d = buildData()
    return { modelTitle: d.modelTitle, models: d.models }
  }

  /** 从粘贴的内容里抠出所有令牌：一行一个也行，逗号/空格混着也行。 */
  const parseKeys = (raw) =>
    String(raw ?? '')
      .split(/[\s,;、，；]+/)
      .map((t) => t.trim())
      .filter((t) => /^ms-[A-Za-z0-9._-]{8,}$/.test(t))
      .filter((t, i, arr) => arr.indexOf(t) === i)

  const addKey = async (raw) => {
    const text = String(raw ?? '').trim()
    if (!text) return { toast: '没读到 Key' }
    const tokens = parseKeys(text)
    if (tokens.length === 0) return { toast: '这不像魔搭令牌（应以 ms- 开头）' }

    const added = []
    const skipped = []
    for (const token of tokens) {
      const result = await pool.add(token)
      if (result.ok) added.push({ id: result.id, token })
      else skipped.push(result.error)
    }
    if (added.length === 0) return { toast: skipped[0] ?? '没有新增 Key' }

    // 加进来就逐个问额度接口：既能认出国际版/大陆版，也能当场发现令牌无效或额度不够。
    const regions = { ai: 0, cn: 0 }
    let invalid = 0
    let low = 0
    for (const { id, token } of added) {
      const state = await quota.refreshOne(id, token, { force: true })
      if (!state?.ok) {
        invalid++
        pool.markFailure(id, '令牌无效', String(state?.error ?? '').slice(0, 80))
        continue
      }
      if (state.region) {
        regions[state.region]++
        await pool.setRegion(id, state.region)
      }
      applyQuota(id, state)
      if (state.available < QUOTA_FLOOR) low++
    }
    refreshPanel()
    refreshStrip()

    const bits = [`新增 ${added.length} 个`]
    if (regions.ai > 0) bits.push(`国际版 ${regions.ai}`)
    if (regions.cn > 0) bits.push(`国内版 ${regions.cn}`)
    if (low > 0) bits.push(`${low} 个额度不足已停用`)
    if (invalid > 0) bits.push(`${invalid} 个令牌无效`)
    if (skipped.length > 0) bits.push(`${skipped.length} 个重复跳过`)
    return { toast: bits.join('｜') }
  }

  ctx.inject(['dshGo'], (dshCtx) => {
    const dshGo = dshCtx.dshGo
    refreshPanel = () => {
      for (const id of ['pool', 'key', 'models']) {
        try {
          dshGo.refresh(id)
        } catch {}
      }
    }
    refreshStrip = () => {
      try {
        dshGo.refresh('pool-strip')
      } catch {}
    }

    /** 面板数据推流的通用外壳：内容变了才重绘，面板一关就停。 */
    const panelData = (build) => (scope, emit) => {
        let stopped = false
        let lastJson = ''
        const tick = () => {
          if (stopped) return
          try {
            const payload = build()
            const json = JSON.stringify(payload)
            if (json === lastJson) return // 没有变化就不重绘，界面元素保持稳定
            lastJson = json
            emit(payload)
          } catch {}
        }
        ready
          .then(() => {
            tick()
            const timer = setInterval(tick, 1500)
            if (typeof timer.unref === 'function') timer.unref()
            stop = () => clearInterval(timer)
          })
          .catch(() => {})
        let stop = () => {}
        return () => {
          stopped = true
          stop()
        }
    }

    const panelActions = {
        async refresh() {
          await Promise.all([refreshQuota(true), refreshCatalog(true)])
          return { toast: '额度已更新', refresh: true }
        },
        async 'pick-model'(scope, event) {
          const model = String(event?.value?.model ?? '')
          const ok = await selectModel(model)
          return ok ? { toast: `默认模型：${model}`, refresh: true } : { toast: '模型名不可用' }
        },
        async 'test-all'() {
          const keys = pool ? [...pool.keys] : []
          if (keys.length === 0) return { toast: '池里还没有 Key' }
          // 注意不能用 /v1/models 验 Key：那个接口是公开的，什么令牌都返回 200。
          // 真正会校验令牌的是额度接口，而且查额度不扣魔粒。
          const rows = await quota.refresh(
            keys.map((k) => ({ id: k.id, key: k.key, region: k.region })),
            { force: true },
          )
          for (const [i, row] of rows.entries()) {
            const k = keys[i]
            if (row.state?.region) await pool.setRegion(k.id, row.state.region)
            if (!row.state?.ok) {
              pool.markFailure(k.id, '令牌无效', String(row.state?.error ?? '').slice(0, 80))
              continue
            }
            if (row.state.available < QUOTA_FLOOR) {
              pool.markFailure(k.id, '额度不足', `剩余 ${row.state.available} 魔粒`, nextQuotaResetAt())
              continue
            }
            pool.restore(k.id)
          }
          refreshPanel()
          refreshStrip()
          const ok = rows.filter((r) => r.state?.ok && r.state.available >= QUOTA_FLOOR).length
          const invalid = rows.filter((r) => !r.state?.ok).length
          const short = rows.length - ok - invalid
          const parts = [`${ok}/${keys.length} 个 Key 可用`]
          if (short > 0) parts.push(`${short} 个额度不足`)
          if (invalid > 0) parts.push(`${invalid} 个令牌无效`)
          return { toast: `测试完成：${parts.join('，')}` }
        },
        'restore-all': async () => {
          await pool.restoreAll()
          router.clearAll()
          refreshPanel()
          refreshStrip()
          return { toast: '已把全部 Key 恢复为可用' }
        },
        // 单 Key 控制：先点列表里的某一行选中，再用下面四个按钮。
        'key-open'(scope, event) {
          const id = String(event?.value?.id ?? '')
          if (!id) return { toast: '没认出这个 Key' }
          keyFocus = id
          deleteArmed = ''
          return { open: 'panel:key', refresh: true }
        },
        'key-prev'() {
          if (keyPage <= 0) return { toast: '已经是第一页了' }
          keyPage--
          return { refresh: true }
        },
        'key-next'() {
          const pages = Math.max(1, Math.ceil((pool?.keys.length ?? 0) / KEYS_PER_PAGE))
          if (keyPage >= pages - 1) return { toast: '已经是最后一页了' }
          keyPage++
          return { refresh: true }
        },
        'key-disable'() {
          const id = pickedKey()
          if (!id) return { toast: '先在上面点一行选中一个 Key' }
          pool.disable(id, '手动禁用')
          router.clearKey?.(id)
          refreshPanel()
          refreshStrip()
          return { toast: `${id} 已禁用，点「恢复」才放开`, refresh: true }
        },
        'key-stop'() {
          const id = pickedKey()
          if (!id) return { toast: '先在上面点一行选中一个 Key' }
          pool.stop(id, '手动停用', nextQuotaResetAt())
          router.clearKey?.(id)
          refreshPanel()
          refreshStrip()
          return { toast: `${id} 停用到北京时间次日 00:01`, refresh: true }
        },
        'key-restore'() {
          const id = pickedKey()
          if (!id) return { toast: '先在上面点一行选中一个 Key' }
          pool.restore(id)
          router.clearKey?.(id)
          refreshPanel()
          refreshStrip()
          return { toast: `${id} 已恢复可用`, refresh: true }
        },
        'key-delete'() {
          const id = pickedKey()
          if (!id) return { toast: '先在上面点一行选中一个 Key' }
          // 删令牌不可撤销，要求连点两次。
          if (deleteArmed !== id) {
            deleteArmed = id
            return { toast: `再点一次「删除」确认删掉 ${id}`, refresh: true }
          }
          deleteArmed = ''
          void pool.remove(id).then(() => {
            quota?.forget?.(id)
            keyFocus = ''
            refreshPanel()
            refreshStrip()
          })
          return { toast: `${id} 已从本机删除`, refresh: true }
        },
        'add-form': async (scope, event) => {
          const value = event?.value
          const raw = typeof value === 'string' ? value : value?.newKey ?? value?.value ?? ''
          const result = await addKey(raw)
          return { ...result, refresh: true }
        },
        'key-back'() {
          return { open: 'panel:pool' }
        },
        async 'refresh-models'() {
          keyPage = keyPage
          await refreshCatalog(true)
          refreshPanel()
          return { toast: '模型列表已重新拉取', refresh: true }
        },
    }

    dshGo.panel('pool', { view: viewPool, data: panelData(buildPoolData), actions: panelActions })
    dshGo.panel('key', { view: viewKey, data: panelData(buildKeyData), actions: panelActions })
    dshGo.panel('models', { view: viewModels, data: panelData(buildModelsData), actions: panelActions })

    dshGo.strip('pool-strip', {
      data(scope, emit) {
        let stop = () => {}
        let lastText = ''
        const tick = () => {
          const s = pool ? pool.status() : { total: 0, available: 0 }
          const ids = (s.keys ?? []).map((k) => k.id)
          const q = quota ? quota.sum(ids) : { available: 0, known: 0 }
          const payload =
            s.total === 0
              ? { text: '魔搭 未配置', tone: 'warn' }
              : {
                  text: `魔搭 ${s.available}/${s.total} · ${q.known > 0 ? `${q.available} 魔粒` : '额度?'}`,
                  tone: s.available > 0 ? 'good' : 'bad',
                }
          const json = JSON.stringify(payload)
          if (json === lastText) return
          lastText = json
          emit(payload)
        }
        ready
          .then(() => {
            tick()
            const timer = setInterval(tick, 5000)
            if (typeof timer.unref === 'function') timer.unref()
            stop = () => clearInterval(timer)
          })
          .catch(() => {})
        return () => stop()
      },
    })

    dshGo.on('addkey', async (scope) => {
      const text = String(scope.clipboard ?? '').trim()
      if (!text) return { toast: '剪贴板里没有文字' }
      const result = await addKey(text)
      return { ...result, refresh: 'pool' }
    })

    dshGo.on('open-pool', () => ({ open: 'panel:pool' }))
  })

  // 插件卸载时必须收尾：停掉心跳、关掉网关，否则热重载会留下占着端口的僵尸实例。
  const cleanups = []
  const onDispose = (fn) => {
    cleanups.push(fn)
    try {
      ctx.effect?.(() => () => {
        try {
          fn()
        } catch {}
      })
    } catch {}
  }

  ready
    .then(() => {
      const stopWatch = pool.startWatch(() => {
        refreshPanel()
        refreshStrip()
      })
      onDispose(stopWatch)
      refreshQuota(true).then(() => sweepQuotaFloor()).catch(() => {})
      refreshCatalog(true).catch(() => {})
      const quotaTimer = setInterval(() => {
        refreshQuota(false).catch(() => {})
      }, 300_000)
      const catalogTimer = setInterval(() => {
        refreshCatalog(false).catch(() => {})
      }, 300_000)
      if (typeof quotaTimer.unref === 'function') quotaTimer.unref()
      if (typeof catalogTimer.unref === 'function') catalogTimer.unref()
      const floorTimer = setInterval(() => sweepQuotaFloor(), 30_000)
      if (typeof floorTimer.unref === 'function') floorTimer.unref()
      onDispose(() => {
        clearInterval(quotaTimer)
        clearInterval(catalogTimer)
        clearInterval(floorTimer)
      })
    })
    .catch((error) => logger?.warn?.(`modelscope-pool: 初始化失败 ${String(error?.message ?? error)}`))

  try {
    ctx.on?.('dispose', () => {
      for (const fn of cleanups.splice(0)) {
        try {
          fn()
        } catch {}
      }
    })
  } catch {}

  // 注册成 DSH 的模型供应商：模型页直接列出池里的模型，选中就能对话。
  ctx.inject(['llm'], (llmCtx) => {
    started
      .then(async () => {
        const entryId = (() => {
          const id = llmCtx?.fiber?.entry?.options?.id
          return typeof id === 'string' && id.length > 0 ? id : name
        })()
        const ok = await registerPoolProvider(llmCtx, {
          providerId: 'modelscope-pool',
          displayName: '魔搭 Key 池',
          entryId,
          getPort: () => proxy?.port ?? 0,
          getKey: () => config.apiKey,
          getModels: () => catalog?.ids ?? [],
          getEntries: () => catalog?.entries ?? [],
          logger,
        })
        providerState = {
          registered: ok === 'declared' ? true : ok,
          declared: ok === 'declared',
          error: ok ? '' : (globalThis.__poolProviderError ?? '宿主缺少 llm 服务或 pi-ai 不可用'),
        }
        try {
          globalThis.__poolEntry = {
            entryId,
            runtimeConfig: typeof llmCtx?.fiber?.runtime?.Config,
            namespaces: (() => {
              try {
                return (llmCtx.get?.('settings')?.describe?.() ?? []).map((row) => row.ns)
              } catch {
                return null
              }
            })(),
          }
          globalThis.__poolDirectory = {
            declared: llmCtx.llm.listConfigurableProviders?.() ?? null,
            routes: llmCtx.llm.listProviders?.() ?? null,
          }
        } catch (error) {
          globalThis.__poolEntry = {
            entryId,
            runtimeConfig: typeof llmCtx?.fiber?.runtime?.Config,
            namespaces: (() => {
              try {
                return (llmCtx.get?.('settings')?.describe?.() ?? []).map((row) => row.ns)
              } catch {
                return null
              }
            })(),
          }
          globalThis.__poolDirectory = { error: String(error?.message ?? error) }
        }
        if (ok) logger?.info?.('modelscope-pool: 已注册模型供应商「魔搭 Key 池」')
      })
      .catch((error) => logger?.warn?.(`modelscope-pool: 供应商注册失败 ${String(error?.message ?? error)}`))
  })

  // 真正的网关只在引擎里起（检查器没有 webServer，也不会占端口）。
  ctx.inject(['webServer'], () => {
    ready
      .then(async () => {
        proxy = createProxy({
          pool,
          config,
          router,
          logger,
          hooks: {
            provider: () => ({
              ...providerState,
              directory: globalThis.__poolDirectory ?? null,
              entry: globalThis.__poolEntry ?? null,
              probe: globalThis.__poolRuntimeProbe ?? null,
              models: (catalog?.ids ?? []).filter((id) => isChatModel(id)).length,
              endpoint: endpoint(),
              provider: 'modelscope-pool',
              routing: router.snapshot(),
            }),
            quotaSuspect: (id, secret) => requeueQuota(id, secret),
            selected: () => String(config.model ?? ''),
            setModel: (model) => selectModel(model),
            models: async (force) => catalog.list({ force }),
            resolveModel: (name) => catalog?.resolve(name)?.id ?? '',
            modelFor: (name, region) => catalog?.modelFor(name, region) ?? '',
            balance: async (force) => {
              const entries = pool.keys.map((k) => ({ id: k.id, key: k.key, region: k.region }))
              const rows = await quota.refresh(entries, { force })
              return rows.map((row) => ({
                id: row.id,
                ok: Boolean(row.state?.ok),
                available: row.state?.ok ? row.state.available : 0,
                total: row.state?.ok ? row.state.total : 0,
                frozen: row.state?.ok ? row.state.frozen : 0,
                error: row.state?.ok ? undefined : row.state?.error,
              }))
            },
          },
        })
        const port = await proxy.listen()
        markStarted(port)
        logger?.info?.(`modelscope-pool: 本地网关 http://127.0.0.1:${port}/v1（${pool.keys.length} 个 Key）`)
        refreshPanel()
        refreshStrip()
      })
      .catch((error) => {
        markStarted(0)
        logger?.warn?.(`modelscope-pool: 网关启动失败 ${String(error?.message ?? error)}`)
      })
    onDispose(() => {
      proxy?.close().catch(() => {})
      proxy = undefined
    })
  })
}