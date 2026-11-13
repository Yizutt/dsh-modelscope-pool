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
import { makeT } from './i18n.js'
import { registerWebAdmin, WEB_ADMIN_PATH } from './web.js'

export const name = 'dsh-modelscope-pool'

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
  const KEYS_PER_PAGE = 10
  const pickedKey = () => (keyFocus && pool?.keys.some((k) => k.id === keyFocus) ? keyFocus : '')


const modelRowOf = (entry, current, t) => {
    const id = String(entry?.id ?? '')
    const isCurrent = id === current
    const regions = entry?.regions ?? []
    const where =
      regions.length > 1
        ? `${t('regionAi')} + ${t('regionCn')}`
        : t.region(regions[0])
    return {
      title: entry?.name || id,
      subtitle: isCurrent ? `${t('currentDefault')} · ${where}` : where,
      trailing: isCurrent ? t('trailingCurrent') : t('trailingUse'),
      icon: isCurrent ? 'check' : 'model',
      tone: isCurrent ? 'good' : undefined,
      action: { id: 'pick-model', args: { model: id } },
    }
  }

  function buildData(locale) {
    const t = makeT(locale)
    const s = pool ? pool.status() : { total: 0, available: 0, cooling: 0, keys: [], stats: { requests: 0 } }
    const ids = s.keys.map((k) => k.id)
    const q = quota ? quota.sum(ids) : { available: 0, known: 0 }
    const model = String(config.model ?? '')
    const modelEntry = catalog?.resolve(model)
    const currentModel = modelEntry?.id ?? model
    const models = (catalog?.entries ?? []).filter((entry) => isChatModel(entry.id))
    const routing = router.snapshot()
    const routed =
      routing.blockedPairs > 0 ? ` ${t('routed', { n: routing.blockedPairs })}` : ''
    const hint =
      s.total === 0
        ? t('hintNoKeys')
        : s.cooling > 0
          ? `${t('hintCooling')}${routed}`
          : model
            ? `${t('hintModel', { model })}${routed}`
            : `${t('hintIdle')}${routed}`

    // 扇形图：Key 池的状态分布（可用 / 额度不足 / 令牌无效 / 其他冷却）
    const order = [
      ['ready', t('bucketReady'), (k) => k.state === 'ok'],
      [
        'low',
        t('bucketLow'),
        (k) => k.reason === '额度不足' || k.reason === '额度用尽',
      ],
      ['invalid', t('bucketInvalid'), (k) => k.reason === '令牌无效'],
      [
        'other',
        t('bucketOther'),
        (k) => k.state !== 'ok' && !['额度不足', '额度用尽', '令牌无效'].includes(k.reason),
      ],
    ]
    const counts = order.map(([key, label, test]) => ({
      key,
      label,
      value: s.keys.filter(test).length,
    }))
    const live = counts.filter((row) => row.value > 0)
    const lowCount = counts.find((row) => row.key === 'low')?.value ?? 0
    const readyCount = counts.find((row) => row.key === 'ready')?.value ?? 0
    const share = {
      kind: 'donut',
      categories: live.map((row) => row.label),
      series: [{ name: 'Key', values: live.map((row) => row.value) }],
      unit: t('unitKey'),
      caption:
        s.total === 0
          ? t('captionNoKeys')
          : t('captionTotal', { total: s.total, ok: readyCount, low: lowCount }),
    }

    // 魔粒估算：每个 Key 按满额 250 计，剩余取各 Key 剩余之和（没查到的按满额算，不凭空记「已用」）。
    const MAGIC_PER_KEY = 250
    const magicTotal = s.total * MAGIC_PER_KEY
    const magicUnknown = Math.max(0, s.total - q.known)
    const magicLeft = q.known > 0 ? q.available + magicUnknown * MAGIC_PER_KEY : magicTotal
    const magicUsed = Math.max(0, magicTotal - magicLeft)
    const magic = {
      total: magicTotal,
      left: magicLeft,
      used: magicUsed,
      caption:
        s.total === 0
          ? t('magicCaptionEmpty')
          : t('magicCaption', {
              total: magicTotal,
              keys: s.total,
              per: MAGIC_PER_KEY,
              left: magicLeft,
              used: magicUsed,
            }),
      brief: t('magicBarCaption', { left: magicLeft, total: magicTotal }),
      categories: [t('magicLeft'), t('magicUsed')],
      series: [{ name: 'Magicubes', values: [magicLeft, magicUsed] }],
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
            [t('rowToken'), focusRaw?.key ?? '—'],
            [t('rowSite'), t.region(focusRow.region)],
            [
              t('rowQuota'),
              focusState?.ok
                ? t('quotaDetail', {
                    n: focusState.available,
                    total: focusState.total,
                    frozen: focusState.frozen,
                  })
                : focusState
                  ? t('quotaFailed', { error: focusState.error })
                  : t('quotaNever'),
            ],
            [
              t('rowState'),
              focusRow.state === 'ok'
                ? t('stateReady')
                : focusRow.manual
                  ? t('stateManual')
                  : `${t.reason(focusRow.reason) || t('hintKeyFallback')}${
                      focusRow.untilAt ? ` · ${t('coolingUntil', { time: fmtCN(focusRow.untilAt) })}` : ''
                    }`,
            ],
            [
              t('rowFails'),
              t('failsDetail', {
                n: focusRow.fails,
                error: focusRow.lastError || t('none'),
                used: focusRow.used ? t('usedSuffix', { n: focusRow.used }) : '',
              }),
            ],
          ],
          hint: t('hintKeyDetail'),
        }
      : { title: t('focusEmpty'), rows: [], hint: '' }

    // 模型列表按站点分组：国际版 → 国内版 → 双站，名字用短名。
    const modelRows = []
    for (const region of ['ai', 'cn']) {
      const group = models.filter((entry) => entry.regions?.length === 1 && entry.regions[0] === region)
      if (group.length === 0) continue
      modelRows.push({
        title: t.region(region),
        icon: 'globe',
        tone: 'info',
        subtitle: t('groupCount', { n: group.length }),
      })
      for (const entry of group) modelRows.push(modelRowOf(entry, currentModel, t))
    }
    const both = models.filter((entry) => (entry.regions?.length ?? 0) > 1)
    if (both.length > 0) {
      modelRows.push({
        title: t('groupBoth'),
        icon: 'globe',
        tone: 'info',
        subtitle: t('groupCount', { n: both.length }),
      })
      for (const entry of both) modelRows.push(modelRowOf(entry, currentModel, t))
    }
    const unknownRegion = models.filter((entry) => (entry.regions?.length ?? 0) === 0)
    if (unknownRegion.length > 0) {
      modelRows.push({
        title: t('groupUnknown'),
        icon: 'globe',
        tone: 'info',
        subtitle: t('groupCount', { n: unknownRegion.length }),
      })
      for (const entry of unknownRegion) modelRows.push(modelRowOf(entry, currentModel, t))
    }

    return {
      available: s.available,
      cooling: s.cooling,
      share,
      shareTitle: t('shareTitle'),
      magicubes: q.known > 0 ? String(q.available) : '—',
      magic,
      endpoint: endpoint(),
      hint,
      modelTitle:
        models.length === 0
          ? t('modelsTitleEmpty')
          : t('modelsTitleCount', {
              n: models.length,
              current: modelEntry?.name ?? model ?? t('modelNotPicked'),
            }),
      keyTitle:
        s.total === 0
          ? t('keyTitleEmpty')
          : t('keyTitlePage', { total: s.total, page: pageNo, pages: pageCount }),
      keyPager:
        s.total > KEYS_PER_PAGE
          ? t('keyPager', { page: pageNo, pages: pageCount, size: KEYS_PER_PAGE })
          : '',
      keys: pageKeys.map((k) => {
        const state = quota?.cached(k.id)
        const used = t('usedTimes', { n: k.used })
        const money = state?.ok
          ? t('quotaLeft', { n: state.available })
          : state && !state.ok
            ? t('quotaUnknown', { error: String(state.error).slice(0, 24) })
            : t('quotaUnchecked')
        const region = t.region(k.region)
        return {
          title: `${k.id} · ${k.masked}${k.id === keyFocus ? t('selectedMark') : ''}`,
          subtitle: k.reason
            ? `${t.reason(k.reason)}（${t('failTimes', { n: k.fails })}）· ${money} · ${region}`
            : `${money} · ${region} · ${used}`,
          trailing:
            k.state === 'ok'
              ? t('stateReady')
              : k.manual
                ? t('stateDisabled')
                : k.untilAt
                  ? t('coolingUntil', { time: fmtCN(k.untilAt) })
                  : t('coolingLeft', { time: fmtLeft(k.leftMs) }),
          icon: k.state === 'ok' ? 'cloud' : k.manual ? 'remove' : 'time',
          tone: k.state === 'ok' ? 'good' : k.manual ? 'bad' : 'warn',
          action: { id: 'key-open', args: { id: k.id } },
        }
      }),
      focus: focusData,
      models: modelRows,
    }
  }
  const viewPool = (scope, caps) => {
    const t = makeT(caps?.locale)
    return {
      v: 2,
      type: 'stack',
      title: t('poolTitle'),
      accent: 'teal',
      children: [
        {
          type: 'row',
          children: [
            { type: 'metric', label: t('metricReady'), value: { $: 'data.available' }, tone: 'good' },
            { type: 'metric', label: t('metricCooling'), value: { $: 'data.cooling' }, tone: 'warn' },
            { type: 'metric', label: t('metricMagicubes'), value: { $: 'data.magicubes' }, tone: 'info' },
          ],
        },
        {
          type: 'progress',
          label: t('magicLabel'),
          value: { $: 'data.magic.left' },
          max: { $: 'data.magic.total' },
          caption: { $: 'data.magic.brief' },
          tone: 'good',
        },
        { type: 'callout', tone: 'info', text: { $: 'data.hint' } },
        { type: 'text', text: { $: 'data.keyTitle' }, style: { size: 'title', weight: 'bold' } },
        { type: 'list', items: { $: 'data.keys' } },
        {
          type: 'actions',
          items: [
            { label: t('btnRefresh'), icon: 'refresh', action: { id: 'refresh' } },
            { label: t('btnTestAll'), icon: 'bolt', action: { id: 'test-all' } },
            { label: t('btnRestoreAll'), icon: 'play', action: { id: 'restore-all' } },
          ],
        },
        {
          type: 'actions',
          items: [
            { label: t('btnPrev'), icon: 'collapse', action: { id: 'key-prev' } },
            { label: t('btnNext'), icon: 'expand', action: { id: 'key-next' } },
          ],
        },
        {
          type: 'form',
          submitLabel: t('formSubmit'),
          submit: 'add-form',
          children: [
            {
              type: 'textField',
              label: t('fieldLabel'),
              bind: 'data.newKey',
              placeholder: t('fieldPlaceholder'),
            },
          ],
        },
      ],
    }
  }

  const viewKey = (scope, caps) => {
    const t = makeT(caps?.locale)
    return {
      v: 2,
      type: 'stack',
      title: t('keyPanelTitle'),
      children: [
        { type: 'text', text: { $: 'data.title' }, style: { size: 'title', weight: 'bold' } },
        { type: 'keyValue', items: { $: 'data.rows' } },
        {
          type: 'actions',
          items: [
            { label: t('btnDisable'), icon: 'remove', action: { id: 'key-disable' } },
            { label: t('btnStop'), icon: 'clock', action: { id: 'key-stop' } },
            { label: t('btnRestore'), icon: 'play', action: { id: 'key-restore' } },
            { label: t('btnDelete'), icon: 'delete', action: { id: 'key-delete' } },
          ],
        },
        { type: 'callout', tone: 'warn', text: { $: 'data.hint' } },
        { type: 'actions', items: [{ label: t('btnBack'), icon: 'list', action: { id: 'key-back' } }] },
      ],
    }
  }

  const viewModels = (scope, caps) => {
    const t = makeT(caps?.locale)
    return {
      v: 2,
      type: 'stack',
      title: t('modelsPanelTitle'),
      children: [
        { type: 'text', text: { $: 'data.modelTitle' }, style: { size: 'title', weight: 'bold' } },
        { type: 'list', items: { $: 'data.models' } },
        { type: 'actions', items: [{ label: t('btnReloadModels'), icon: 'refresh', action: { id: 'refresh-models' } }] },
      ],
    }
  }

  const buildPoolData = (locale) => {
    const d = buildData(locale)
    return {
      available: d.available,
      cooling: d.cooling,
      magicubes: d.magicubes,
      share: d.share,
      magic: d.magic,
      hint: d.hint,
      keyTitle: d.keyTitle,
      keys: d.keys,
      focusTitle: d.focus.title,
    }
  }
  const buildKeyData = (locale) => {
    const d = buildData(locale)
    return {
      title: d.focus.title,
      rows: d.focus.rows,
      hint: d.focus.hint || makeT(locale)('hintKeyFallback'),
    }
  }
  const buildModelsData = (locale) => {
    const d = buildData(locale)
    return { modelTitle: d.modelTitle, models: d.models }
  }
  /** 从粘贴的内容里抠出所有令牌：一行一个也行，逗号/空格混着也行。 */
  const parseKeys = (raw) =>
    String(raw ?? '')
      .split(/[\s,;、，；]+/)
      .map((t) => t.trim())
      .filter((t) => /^ms-[A-Za-z0-9._-]{8,}$/.test(t))
      .filter((t, i, arr) => arr.indexOf(t) === i)

  const addKey = async (raw, locale) => {
    const t = makeT(locale)
    const text = String(raw ?? '').trim()
    if (!text) return { toast: t('toastNoInput') }
    const tokens = parseKeys(text)
    if (tokens.length === 0) return { toast: t('toastNotMs') }

    const added = []
    const skipped = []
    for (const token of tokens) {
      const result = await pool.add(token)
      if (result.ok) added.push({ id: result.id, token })
      else skipped.push(result.error)
    }
    if (added.length === 0) return { toast: skipped[0] ?? t('toastNoNew') }

    // 加进来就逐个问额度接口：既能认出站点，也能当场发现令牌无效或额度不够。
    const regions = { ai: 0, cn: 0 }
    let invalid = 0
    let low = 0
    for (const { id, token } of added) {
      const state = await quota.refreshOne(id, token, { force: true })
      if (!state?.ok) {
        invalid++
        pool.markFailure(id, '\u4ee4\u724c\u65e0\u6548', String(state?.error ?? '').slice(0, 80))
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

    const bits = [t('addDone', { n: added.length })]
    if (regions.ai > 0) bits.push(t('addIntl', { n: regions.ai }))
    if (regions.cn > 0) bits.push(t('addCn', { n: regions.cn }))
    if (low > 0) bits.push(t('addLow', { n: low }))
    if (invalid > 0) bits.push(t('addInvalid', { n: invalid }))
    if (skipped.length > 0) bits.push(t('addSkipped', { n: skipped.length }))
    return { toast: bits.join(t('joinArrow')) }
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
    const panelData = (build) => (scope, emit, caps) => {
        let stopped = false
        let lastJson = ''
        const tick = () => {
          if (stopped) return
          try {
            const payload = build(caps?.locale)
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

    // 点按必须在 3 秒内返回，否则 App 会提示「没有响应」。
    // 刷新额度 / 测试全部 / 拉模型 / 校验 Key 都要联网，所以先回 pending，结果走延后效果。
    const defer = (label, work) => ({
      pending: { label, timeoutMs: 60_000 },
      result: async () => {
        const value = await work()
        refreshPanel()
        refreshStrip()
        return value
      },
    })

    const panelActions = {
        refresh(scope, event) {
          const t = makeT(event?.locale)
          return defer(t('pendingRefresh'), async () => {
            await refreshQuota(true)
            await refreshCatalog(true)
            return { toast: t('toastQuotaUpdated') }
          })
        },
        async 'pick-model'(scope, event) {
          const t = makeT(event?.locale)
          const model = String(event?.value?.model ?? '')
          const ok = await selectModel(model)
          return ok
            ? { toast: t('toastModelSet', { model }), refresh: true }
            : { toast: t('toastModelBad') }
        },
        'test-all'(scope, event) {
          const t = makeT(event?.locale)
          const keys = pool ? [...pool.keys] : []
          if (keys.length === 0) return { toast: t('toastNoKeys') }
          // 注意不能用 /v1/models 验 Key：那个接口是公开的，什么令牌都返回 200。
          // 真正会校验令牌的是额度接口，而且查额度不扣魔粒。
          return defer(t('pendingTest'), async () => {
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
          const parts = [t('partOk', { ok, total: keys.length })]
          if (short > 0) parts.push(t('partShort', { n: short }))
          if (invalid > 0) parts.push(t('partInvalid', { n: invalid }))
          return { toast: t('toastTestDone', { parts: parts.join(' · ') }) }
          })
        },
        'restore-all': async (scope, event) => {
          const t = makeT(event?.locale)
          await pool.restoreAll()
          router.clearAll()
          refreshPanel()
          refreshStrip()
          return { toast: t('toastRestored') }
        },
        // 单 Key 控制：先点列表里的某一行选中，再用下面四个按钮。
        'key-open'(scope, event) {
          const t = makeT(event?.locale)
          const id = String(event?.value?.id ?? '')
          if (!id) return { toast: t('toastNoKeyId') }
          keyFocus = id
          deleteArmed = ''
          return { open: 'panel:key', refresh: true }
        },
        'key-prev'(scope, event) {
          const t = makeT(event?.locale)
          if (keyPage <= 0) return { toast: t('toastFirstPage') }
          keyPage--
          return { refresh: true }
        },
        'key-next'(scope, event) {
          const t = makeT(event?.locale)
          const pages = Math.max(1, Math.ceil((pool?.keys.length ?? 0) / KEYS_PER_PAGE))
          if (keyPage >= pages - 1) return { toast: t('toastLastPage') }
          keyPage++
          return { refresh: true }
        },
        'key-disable'(scope, event) {
          const t = makeT(event?.locale)
          const id = pickedKey()
          if (!id) return { toast: t('toastNoPick') }
          pool.disable(id, '手动禁用')
          router.clearKey?.(id)
          refreshPanel()
          refreshStrip()
          return { toast: t('toastDisabled', { id }), refresh: true }
        },
        'key-stop'(scope, event) {
          const t = makeT(event?.locale)
          const id = pickedKey()
          if (!id) return { toast: t('toastNoPick') }
          pool.stop(id, '手动停用', nextQuotaResetAt())
          router.clearKey?.(id)
          refreshPanel()
          refreshStrip()
          return { toast: t('toastStopped', { id }), refresh: true }
        },
        'key-restore'(scope, event) {
          const t = makeT(event?.locale)
          const id = pickedKey()
          if (!id) return { toast: t('toastNoPick') }
          pool.restore(id)
          router.clearKey?.(id)
          refreshPanel()
          refreshStrip()
          return { toast: t('toastRestoredOne', { id }), refresh: true }
        },
        'key-delete'(scope, event) {
          const t = makeT(event?.locale)
          const id = pickedKey()
          if (!id) return { toast: t('toastNoPick') }
          // 删令牌不可撤销，要求连点两次。
          if (deleteArmed !== id) {
            deleteArmed = id
            return { toast: t('toastDeleteArm', { id }), refresh: true }
          }
          deleteArmed = ''
          void pool.remove(id).then(() => {
            quota?.forget?.(id)
            keyFocus = ''
            refreshPanel()
            refreshStrip()
          })
          return { toast: t('toastDeleted', { id }), refresh: true }
        },
        'add-form': (scope, event) => {
          const t = makeT(event?.locale)
          const value = event?.value
          const raw = typeof value === 'string' ? value : value?.newKey ?? value?.value ?? ''
          return defer(t('pendingAdd'), async () => {
            const result = await addKey(raw, event?.locale)
            return { toast: result?.toast ?? t('toastNoNew') }
          })
        },
        'key-back'() {
          return { open: 'panel:pool' }
        },
        'refresh-models'(scope, event) {
          const t = makeT(event?.locale)
          return defer(t('pendingModels'), async () => {
            await refreshCatalog(true)
            return { toast: t('toastModelsReloaded') }
          })
        },
    }

    dshGo.panel('pool', { view: viewPool, data: panelData(buildPoolData), actions: panelActions })
    dshGo.panel('key', { view: viewKey, data: panelData(buildKeyData), actions: panelActions })
    dshGo.panel('models', { view: viewModels, data: panelData(buildModelsData), actions: panelActions })

    dshGo.strip('pool-strip', {
      data(scope, emit, caps) {
        const t = makeT(caps?.locale)
        let stop = () => {}
        let lastText = ''
        const tick = () => {
          const s = pool ? pool.status() : { total: 0, available: 0 }
          const ids = (s.keys ?? []).map((k) => k.id)
          const q = quota ? quota.sum(ids) : { available: 0, known: 0 }
          const payload =
            s.total === 0
              ? { text: t('stripEmpty'), tone: 'warn' }
              : {
                  text: t('stripText', {
                    ok: s.available,
                    total: s.total,
                    quota: q.known > 0 ? t('stripQuota', { n: q.available }) : t('stripQuotaUnknown'),
                  }),
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

    dshGo.on('addkey', async (scope, event) => {
      const text = String(scope.clipboard ?? '').trim()
      if (!text) return { toast: makeT(event?.locale)('toastNoClipboard') }
      const result = await addKey(text, event?.locale)
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
          displayName: makeT()('poolTitle'),
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
  // 网页版 / 桌面版：原生面板只在 dsh-go 里出现，这里补一个同源管理页。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx?.webServer
    if (webServer && typeof webServer.register === 'function') {
      const getState = () => {
        const status = pool ? pool.status() : { total: 0, available: 0, cooling: 0, keys: [] }
        const ids = status.keys.map((k) => k.id)
        const sum = quota ? quota.sum(ids) : { available: 0, known: 0 }
        const per = 250
        const total = status.total * per
        const unknown = Math.max(0, status.total - sum.known)
        const left = sum.known > 0 ? sum.available + unknown * per : total
        return {
          total: status.total,
          available: status.available,
          cooling: status.cooling,
          magic: { total, left, used: Math.max(0, total - left) },
          model: String(config.model ?? ''),
          models: (catalog?.entries ?? [])
            .filter((entry) => isChatModel(entry.id))
            .map((entry) => ({ id: entry.id, name: entry.name || entry.id, regions: entry.regions ?? [] })),
          keys: status.keys.map((k) => {
            const state = quota?.cached(k.id)
            return {
              id: k.id,
              masked: k.masked,
              region: k.region,
              state: k.state,
              reason: k.reason ?? '',
              manual: Boolean(k.manual),
              untilAt: k.untilAt ?? 0,
              used: k.used ?? 0,
              quota: state?.ok
                ? { ok: true, available: state.available, total: state.total, frozen: state.frozen }
                : { ok: false, available: 0, total: 0, frozen: 0, error: state?.error ?? '' },
            }
          }),
        }
      }

      const doAction = async (action, payload) => {
        const id = String(payload?.id ?? '')
        const after = () => {
          refreshPanel()
          refreshStrip()
        }
        switch (action) {
          case 'refresh':
            await refreshQuota(true)
            await refreshCatalog(true)
            after()
            return makeT()('toastQuotaUpdated')
          case 'test': {
            const keys = pool ? [...pool.keys] : []
            if (keys.length === 0) return makeT()('toastNoKeys')
            const rows = await quota.refresh(
              keys.map((k) => ({ id: k.id, key: k.key, region: k.region })),
              { force: true },
            )
            for (const [i, row] of rows.entries()) {
              const key = keys[i]
              if (row.state?.region) await pool.setRegion(key.id, row.state.region)
              if (!row.state?.ok) {
                pool.markFailure(key.id, '令牌无效', String(row.state?.error ?? '').slice(0, 80))
                continue
              }
              if (row.state.available < QUOTA_FLOOR) {
                pool.markFailure(key.id, '额度不足', `剩余 ${row.state.available} 魔粒`, nextQuotaResetAt())
                continue
              }
              pool.restore(key.id)
            }
            after()
            const t = makeT()
            const ready = rows.filter((r) => r.state?.ok && r.state.available >= QUOTA_FLOOR).length
            return t('toastTestDone', { parts: t('partOk', { ok: ready, total: keys.length }) })
          }
          case 'restoreAll':
            await pool.restoreAll()
            router.clearAll()
            after()
            return makeT()('toastRestored')
          case 'disable':
            if (!id) return makeT()('toastNoKeyId')
            pool.disable(id, '手动禁用')
            router.clearKey?.(id)
            after()
            return makeT()('toastDisabled', { id })
          case 'stop':
            if (!id) return makeT()('toastNoKeyId')
            pool.stop(id, '手动停用', nextQuotaResetAt())
            router.clearKey?.(id)
            after()
            return makeT()('toastStopped', { id })
          case 'restore':
            if (!id) return makeT()('toastNoKeyId')
            pool.restore(id)
            router.clearKey?.(id)
            after()
            return makeT()('toastRestoredOne', { id })
          case 'remove':
            if (!id) return makeT()('toastNoKeyId')
            await pool.remove(id)
            quota?.forget?.(id)
            after()
            return makeT()('toastDeleted', { id })
          case 'add': {
            const result = await addKey(String(payload?.value ?? ''), undefined)
            return result?.toast ?? makeT()('toastNoNew')
          }
          case 'setModel': {
            const ok = await selectModel(String(payload?.value ?? ''))
            return ok ? makeT()('toastModelSet', { model: payload.value }) : makeT()('toastModelBad')
          }
          default:
            throw new Error(`unknown action ${action}`)
        }
      }

      try {
        ctx.effect(() => registerWebAdmin(webServer, { getState, doAction, logger }))
        logger?.info?.(`modelscope-pool: 网页/桌面端管理页 ${WEB_ADMIN_PATH}`)
      } catch (error) {
        logger?.warn?.(`modelscope-pool: 管理页注册失败 ${String(error?.message ?? error)}`)
      }
    }

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