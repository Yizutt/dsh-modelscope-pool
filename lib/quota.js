// 魔搭「魔粒」额度查询：只读接口，查额度本身不扣额度。
// 这个接口会真正校验令牌（/v1/models 是公开的，拿它验 Key 等于没验），
// 而且国际版和国内版的令牌互不通用，所以「哪个站点返回 200」就等于认出了 Key 属于哪个版本。
export const REGIONS = {
  ai: {
    id: 'ai',
    label: '国际版',
    site: 'modelscope.ai',
    balance: 'https://modelscope.ai/openapi/v1/magicubes/balance',
    inference: 'https://api-inference.modelscope.ai/v1',
  },
  cn: {
    id: 'cn',
    label: '国内版',
    site: 'modelscope.cn',
    balance: 'https://modelscope.cn/openapi/v1/magicubes/balance',
    inference: 'https://api-inference.modelscope.cn/v1',
  },
}
const REGION_ORDER = ['ai', 'cn']
const BALANCE_URLS = REGION_ORDER.map((r) => REGIONS[r].balance)

// 一次刷 95 个 Key 的额度时别全并发，免得额度接口自己把我们限流（那也是一种 429）。
const CONCURRENCY = 6

export function createQuotaBook({ ttlMs = 60_000, timeoutMs = 12_000, logger } = {}) {
  const cache = new Map() // keyId -> { at, state }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 429 是「问得太急」，不是 Key 坏了：退让重试，别把好 Key 判死。 */
  async function ask(url, secret) {
    let last
    for (let i = 0; i < 3; i++) {
      if (i > 0) await sleep(600 * i * (1 + Math.random()))
      try {
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        })
        const body = await res.json().catch(() => undefined)
        if (res.ok && body?.success !== false) {
          const data = body?.data ?? {}
          return {
            ok: true,
            available: Number(data.available_balance ?? data.total_balance ?? 0),
            total: Number(data.total_balance ?? data.available_balance ?? 0),
            frozen: Number(data.frozen_amount ?? 0),
            at: Date.now(),
          }
        }
        last = {
          status: res.status,
          error: String(body?.message ?? body?.code ?? `HTTP ${res.status}`).slice(0, 40),
        }
        if (res.status !== 429 && res.status !== 503) break
      } catch (error) {
        last = { status: 0, error: String(error?.cause?.code ?? error?.message ?? error).slice(0, 40) }
      }
    }
    return { ok: false, ...last }
  }

  /**
   * 查一个 Key 的额度，顺便认出它的版本。
   * preferred 是已知版本；先按它试，认不出再试另一个站点。
   */
  async function fetchOne(secret, preferred) {
    const order = preferred && REGIONS[preferred] ? [preferred, ...REGION_ORDER.filter((r) => r !== preferred)] : REGION_ORDER
    const attempts = []
    for (const region of order) {
      const info = REGIONS[region]
      const state = await ask(info.balance, secret)
      if (state.ok) return { ...state, region }
      attempts.push(`${info.site}: ${state.error}`)
      // 401/403 才说明「这个版本不认这个令牌」，值得换版本再试；
      // 429/网络问题换版本也没用，直接记下。
      if (state.status !== 401 && state.status !== 403) break
    }
    return { ok: false, error: attempts.join(' | ').slice(0, 150), at: Date.now() }
  }

  return {
    /** 只要缓存，不联网（界面每秒重绘时用）。 */
    cached(id) {
      return cache.get(id)?.state
    },
    /** 全部 Key 的可用额度之和；没查到的按 0 计。 */
    sum(ids) {
      let available = 0
      let known = 0
      for (const id of ids) {
        const state = cache.get(id)?.state
        if (state?.ok) {
          available += state.available
          known++
        }
      }
      return { available, known }
    },
    async refresh(entries, { force = false } = {}) {
      const now = Date.now()
      const jobs = []
      for (const entry of entries) {
        const hit = cache.get(entry.id)
        if (!force && hit && now - hit.at < ttlMs) continue
        jobs.push(() =>
          fetchOne(entry.key, entry.region).then((state) => {
            cache.set(entry.id, { at: Date.now(), state })
            if (!state.ok) logger?.warn?.(`modelscope-pool: key ${entry.id} 额度查询失败（${state.error}）`)
            return state
          }),
        )
      }
      for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        await Promise.all(jobs.slice(i, i + CONCURRENCY).map((job) => job()))
        if (i + CONCURRENCY < jobs.length) await sleep(250)
      }
      return entries.map((entry) => ({ id: entry.id, state: cache.get(entry.id)?.state }))
    },

    /** 单个 Key 的额度：refresh 的窄版本，429 之后重试查询时用。 */
    async refreshOne(id, secret, { force = false } = {}) {
      const [row] = await this.refresh([{ id, key: secret }], { force })
      return row?.state
    },
    forget(id) {
      cache.delete(id)
    },
  }
}