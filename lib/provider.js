// 把本地聚合网关注册成 DSH 的模型供应商：
// 「模型」页里直接出现「魔搭 Key 池」，选中即可对话，请求仍由网关做多 Key 轮换。
// 做法与 dsh-connect-modelscope 相同：pi-ai provider + PiAiAdapter。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const HOST_ROOTS = ['/opt/dsh', process.cwd()]
const DEFAULT_CONTEXT_WINDOW = 131072
const IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}

// 这些类型的模型不能用来对话，列出来只会干扰选择。
const NON_CHAT = [/(^|[/-])(wan|hunyuanvideo|i2v|t2v|vace|animate|cogvideox)/i, /(image|flux|kolors|sd[-_]?xl|qwen-image|seedream)/i, /(speech|tts|asr|whisper|cosyvoice|audio)/i, /(embedding|rerank|bge-|gte-)/i]

export const isChatModel = (id) => !NON_CHAT.some((re) => re.test(String(id)))

const prettyName = (id) => {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 插件不在 profile 的 node_modules 里，宿主包要按 dsh 安装目录兜底解析。 */
const HOST_SPECIFIER = {
  '@earendil-works/pi-ai': (root) => `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  '@earendil-works/pi-ai/api/openai-completions.lazy': (root) =>
    `${root}/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js`,
  '@deepseek-ai/dsh-llm': (root) => `${root}/node_modules/@deepseek-ai/dsh-llm/lib/index.js`,
  '@deepseek-ai/dsh-llm-pi-ai': (root) => `${root}/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`,
}

async function loadHost(specifier) {
  try {
    return await import(specifier)
  } catch (first) {
    for (const root of HOST_ROOTS) {
      const guess = HOST_SPECIFIER[specifier]?.(root)
      if (!guess) continue
      try {
        return await import(pathToFileURL(guess).href)
      } catch {}
      try {
        const require = createRequire(join(root, 'noop.cjs'))
        return await import(pathToFileURL(require.resolve(specifier)).href)
      } catch {}
    }
    throw first
  }
}

const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('local-modelscope-pool has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: { async env() {}, async fileExists() { return false } },
}

/**
 * @param ctx 注入过 llm 的上下文
 * @param options.providerId 供应商 id（出现在模型页）
 * @param options.displayName 供应商显示名
 * @param options.getPort 当前网关端口
 * @param options.getKey 网关口令（没设就是空）
 * @param options.getModels 当前可用模型 id 列表
 * @param options.getEntries 带版本/短名的模型条目（优先于 getModels）
 * @param options.entryId 本插件在 loader 里的条目 id
 */
const REGION_TAG = { ai: '国际版', cn: '国内版' }

/** 模型页里显示的名字：短名 + 版本，例如「DeepSeek-V4-Flash-1017 · 国际版」。 */
const displayNameOf = (entry) => {
  const base = String(entry?.name ?? '').trim() || prettyName(entry?.id)
  const regions = Array.isArray(entry?.regions) ? entry.regions : []
  // 两个站点都有就不加后缀，避免模型页里一堆「· 双站」。
  if (regions.length === 0 || regions.length > 1) return base
  const tag = REGION_TAG[regions[0]] ?? ''
  return tag ? `${base} · ${tag}` : base
}

export async function registerPoolProvider(ctx, { providerId, displayName, getPort, getKey, getModels, getEntries, entryId, logger }) {
  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') return false
  globalThis.__poolProviderDeclared = false
  // 配置里声明的路由由 pi-ai 在启动早期挂上；我们稍后再决定是否补一个适配器。
  try {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    if ((ctx.llm.listProviders?.() ?? []).some((route) => route.id === providerId)) {
      globalThis.__poolProviderDeclared = true
      return 'declared'
    }
  } catch {}

  // 配置里已经声明了同名供应商（比如写进 cordis.patch.yml 的同一条），
  // 宿主会自己把它挂上，重复注册会撞 DUPLICATE_DIRECTORY，直接让位。
  try {
    const rows = ctx.llm.listConfigurableProviders?.() ?? []
    if (rows.some((row) => row.provider === providerId && row.declared === true)) {
      globalThis.__poolProviderDeclared = true
      return 'declared'
    }
  } catch {}

  let createProvider, openAICompletionsApi, resolveRetryPolicy, PiAiAdapter
  try {
    ;[{ createProvider }, { openAICompletionsApi }, { resolveRetryPolicy }, { PiAiAdapter }] = await Promise.all([
      loadHost('@earendil-works/pi-ai'),
      loadHost('@earendil-works/pi-ai/api/openai-completions.lazy'),
      loadHost('@deepseek-ai/dsh-llm'),
      loadHost('@deepseek-ai/dsh-llm-pi-ai'),
    ])
  } catch (error) {
    globalThis.__poolProviderError = String(error?.message ?? error)
    logger?.warn?.(`modelscope-pool: 模型供应商注册跳过（${String(error?.message ?? error)}）`)
    return false
  }

  const baseUrl = () => `http://127.0.0.1:${getPort() || 8899}/v1`
  const token = () => String(getKey?.() ?? '').trim() || 'pool-local'

  const entriesOf = () => {
    const rows = typeof getEntries === 'function' ? getEntries() : []
    if (Array.isArray(rows) && rows.length > 0) return rows
    return (typeof getModels === 'function' ? getModels() : []).map((id) => ({ id }))
  }

  const buildModels = () =>
    entriesOf()
      .filter((entry) => isChatModel(entry.id))
      .map((entry) => ({
        id: entry.id,
        name: displayNameOf(entry),
        api: 'openai-completions',
        provider: providerId,
        baseUrl: baseUrl(),
        input: ['text'],
        // DSH 拒绝没有正整数上下文的模型，这里给保守值。
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
      }))

  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: '本地网关口令',
          async resolve() {
            return { auth: { apiKey: token() }, source: displayName }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: 180000,
    retryPolicy: resolveRetryPolicy(undefined, 'local-modelscope-pool retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    ...IMAGE_BUDGETS,
    piProvider: provider,
  }

  const adapter = new PiAiAdapter({
    profiles: () => new Map([[providerId, profile]]),
    auth: INERT_AUTH,
    resolveApiKey: async () => token(),
  })

  ctx.effect(() => ctx.llm.registerAdapter([providerId], adapter))

  ctx.effect(() => {
    if (typeof ctx.llm.registerConfigurableProviders !== 'function') return
    let off
    try {
      off = ctx.llm.registerConfigurableProviders([
        { provider: providerId, displayName, settingsNs: entryId, settingsPath: [], declared: false },
      ])
    } catch (error) {
      globalThis.__poolProviderError = `directory: ${String(error?.message ?? error)}`
      logger?.warn?.(`modelscope-pool: 供应商目录注册失败（${String(error?.message ?? error)}）`)
      return
    }
    return () => {
      try {
        off?.()
      } catch {}
    }
  })

  ctx.effect(() => {
    if (typeof ctx.llm.registerModelDiscovery !== 'function') return
    let off
    try {
      off = ctx.llm.registerModelDiscovery(entryId, async () =>
        buildModels().map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, inputModalities: ['text'] })),
      )
    } catch (error) {
      logger?.warn?.(`modelscope-pool: 模型发现注册失败（${String(error?.message ?? error)}）`)
      return
    }
    return () => {
      try {
        off?.()
      } catch {}
    }
  })

  return true
}