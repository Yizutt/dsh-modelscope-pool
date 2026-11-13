// 本地 OpenAI 兼容聚合网关：把请求转给魔搭推理接口，
// 遇到 Key 级错误就换下一个 Key：额度用尽停用到次日 00:01（北京时间），
// 令牌失效/限流这类临时问题冷却 5 分钟。
import http from 'node:http'
import { Readable } from 'node:stream'
import { nextQuotaResetAt } from './pool.js'
import { REGIONS } from './quota.js'
import { modelUnavailable } from './route.js'

const DISABLE_STATUS = new Set([401, 402, 429])
// 403 多半是「这个账号没开这个模型」，换 Key 可能就好了，所以只轮换、不停用。
const ROTATE_STATUS = new Set([403])
const CLIENT_STATUS = new Set([400, 404, 405, 409, 413, 422])
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'host', 'content-length', 'authorization'])

/**
 * 「余额/额度真的用完了」和「只是被限流」要分开处理：
 * 前一种要停到次日 00:01，后者冷却几分钟就好。
 * 魔搭的实际报错是 429 + {"message":"insufficient balance"}，
 * 另外还见过 QuotaLimitExceed / E3027 / quota exceeded。
 */
export function quotaLike(text) {
  const s = String(text ?? '')
  if (/Throttling\.(ServiceOverloaded|ResourceExhausted)/i.test(s)) return false
  return /QuotaLimitExceed|E3027|insufficient[_\s-]?(quota|balance|funds)|quota[_\s-]?exceeded|AccountOverdue|(余额|额度)不足/i.test(s)
}

function reasonOf(status) {
  if (status === 401) return '令牌无效'
  if (status === 403) return '无权访问'
  if (status === 402) return '额度用尽'
  if (status === 429) return '被限流'
  return '额度用尽'
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

function fail(res, status, message, code = 'pool_error') {
  sendJson(res, status, { error: { message, type: code, code } })
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('请求体太大'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function copyHeaders(upstream, res) {
  for (const [name, value] of upstream.headers) {
    if (HOP.has(name.toLowerCase())) continue
    try {
      res.setHeader(name, value)
    } catch {}
  }
}

function isStreaming(headers, body) {
  const ct = String(headers['content-type'] ?? '')
  if (ct.includes('text/event-stream')) return true
  if (!body?.length) return false
  try {
    return JSON.parse(body.toString('utf8'))?.stream === true
  } catch {
    return false
  }
}

/** 把请求体里的 model 换成路由选中的那个；本来就是它就不动，别白序列化一遍大 body。 */
function withModel(body, model, method) {
  if (!body?.length || method === 'GET' || method === 'HEAD') return body
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (!parsed || typeof parsed !== 'object') return body
    if (parsed.model === model) return body
    parsed.model = model
    return Buffer.from(JSON.stringify(parsed))
  } catch {
    return body
  }
}

export function createProxy({ pool, config, router, logger, hooks = {} }) {
  // 上游可以有多条线路：主线路连不上就自动换，客户端无感。
  // 国际版和国内版的推理域名不同，Key 认出版本后优先走自己那一边。
  const allEndpoints = (() => {
    const list = Array.isArray(config.upstreams) ? config.upstreams : []
    const all = [config.upstream, ...list, ...Object.values(REGIONS).map((r) => r.inference)]
      .map((u) => String(u ?? '').trim().replace(/\/+$/, ''))
      .filter((u) => /^https?:\/\//.test(u))
    const unique = [...new Set(all)]
    return unique.length > 0 ? unique : ['https://api-inference.modelscope.ai/v1']
  })()
  let boundPort = 0

  const authorized = (req) => {
    if (!config.apiKey) return true
    const auth = String(req.headers.authorization ?? '')
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    return token === config.apiKey
  }

  async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return fail(res, 400, '地址看不懂')
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const s = pool.status()
      return sendJson(res, 200, {
        service: 'dsh-modelscope-pool',
        endpoint: `http://127.0.0.1:${boundPort}/v1`,
        keys: { total: s.total, available: s.available, cooling: s.cooling },
      })
    }

    if (url.pathname === '/healthz') {
      const s = pool.status()
      return sendJson(res, s.available > 0 ? 200 : 503, { ok: s.available > 0, total: s.total, available: s.available, cooling: s.cooling })
    }

    if (!authorized(req)) return fail(res, 401, '本地网关的访问口令不对', 'invalid_token')

    if (req.method === 'GET' && url.pathname === '/v1/pool/status') {
      const s = pool.status()
      return sendJson(res, 200, {
        endpoint: `http://127.0.0.1:${boundPort}/v1`,
        total: s.total,
        available: s.available,
        cooling: s.cooling,
        requests: s.stats.requests,
        failovers: s.stats.failovers,
        keys: s.keys.map((k) => ({
          id: k.id,
          key: k.masked,
          region: k.region ?? '',
          state: k.state,
          cooldownSec: Math.ceil(k.leftMs / 1000),
          untilAt: k.untilAt,
          resumeAt: k.untilAt ? new Date(k.untilAt + 8 * 3600_000).toISOString().slice(11, 16) : '',
          reason: k.reason,
          lastError: k.lastError,
          used: k.used,
        })),
      })
    }

    // 本地接口要排在 /v1/* 转发之前，否则会被当成上游路径。
    if (req.method === 'GET' && url.pathname === '/v1/pool/provider') {
      return sendJson(res, 200, hooks.provider?.() ?? { registered: false })
    }

    if (req.method === 'GET' && url.pathname === '/v1/pool/models') {
      const models = (await hooks.models?.(false)) ?? []
      return sendJson(res, 200, { selected: hooks.selected?.() ?? '', models })
    }

    if (req.method === 'GET' && url.pathname === '/v1/pool/balance') {
      const list = (await hooks.balance?.(url.searchParams.get('refresh') === '1')) ?? []
      return sendJson(res, 200, { keys: list, total: list.reduce((sum, k) => sum + (k.ok ? k.available : 0), 0) })
    }

    if (req.method === 'POST' && url.pathname === '/v1/pool/model') {
      let payload
      try {
        payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
      } catch {
        return fail(res, 400, '请求体不是 JSON')
      }
      const model = String(payload?.model ?? '').trim()
      if (!model) return fail(res, 400, '缺少 model')
      const saved = (await hooks.setModel?.(model)) ?? false
      return sendJson(res, 200, { ok: saved, selected: model })
    }

    if (!url.pathname.startsWith('/v1/')) return fail(res, 404, '没有这个接口')

    let body
    try {
      body = await readBody(req)
    } catch (error) {
      return fail(res, error.status ?? 400, '读取请求失败')
    }

    const streaming = isStreaming(req.headers, body)
    const baseHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase()
      if (HOP.has(lower)) continue
      if (value !== undefined) baseHeaders[lower] = value
    }

    // 客户端要的模型：没写或写 auto 就交给路由决定。
    const requested = (() => {
      if (!body?.length || req.method === 'GET' || req.method === 'HEAD') return ''
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        const model = typeof parsed?.model === 'string' ? parsed.model.trim() : ''
        return model === 'auto' || model === 'pool-auto' ? '' : model
      } catch {
        return ''
      }
    })()

    // 无感路由：模型固定为客户端要的那个（auto 时用默认模型），只换 Key。
    // 客户端可能用短名（DeepSeek-V4-Flash-1017），这里换回上游真实 id。
    const resolved = requested && hooks?.resolveModel ? String(hooks.resolveModel(requested) ?? '') : ''
    const model = resolved || requested || String(config.model ?? '').trim()
    const path = url.pathname.slice(3)
    let endpointIndex = 0

    pool.stats.requests++
    let lastStatus = 0
    let lastText = ''
    let attempts = 0
    let networkFails = 0
    const maxNetworkFails = Math.max(2, allEndpoints.length * 2)

    // 「这个模型上办不了的 Key」直接跳过，别每次都从第一个开始撞。
    // 这个模型已经被确认「所有 Key 都办不了」时直接回错误，不再把 87 个 Key 扫一遍。
    if (model && router?.modelDead?.(model)) {
      res.setHeader('retry-after', '300')
      return fail(res, 403, `这个模型当前所有 Key 都拿不到（可能没开通），5 分钟后会再试`, 'model_unavailable')
    }

    const tried = new Set(router?.blockedKeys?.(model) ?? [])
    const skipped = tried.size
    const maxAttempts = Math.max(1, pool.keys.length)
    // 第一次扫这个模型时最多撞这么多个 Key：够覆盖「权限只在少数账号上」，
    // 又不至于让用户干等十几秒。撞满就整体标记，下次直接快速失败。
    const maxDeniedScan = Math.min(maxAttempts, 24)
    let denied = 0

    while (attempts < maxAttempts) {
      const key = pool.pick(tried)
      if (!key) break
      tried.add(key.id)
      attempts++
      if (attempts + skipped > 1) pool.stats.failovers++

      const live = allEndpoints.filter((ep) => router?.endpointOk?.(ep) !== false)
      const usable = live.length > 0 ? live : allEndpoints
      // Key 认出的版本优先；版本未知或该线路被标记坏了，就按顺序轮。
      const own = key.region ? REGIONS[key.region]?.inference : ''
      const base = own && usable.includes(own) ? own : usable[endpointIndex % usable.length]
      const target = `${base}${path}${url.search}`
      // 同一个模型在不同站点可能有不同 id，按这个 Key 的站点换一次。
      const upstreamModel = (model && hooks?.modelFor?.(model, key.region)) || model
      const bodyForModel = upstreamModel ? withModel(body, upstreamModel, req.method) : body

      const controller = new AbortController()
      const timer = streaming ? null : setTimeout(() => controller.abort(), Number(config.timeoutMs) || 120_000)
      if (timer && typeof timer.unref === 'function') timer.unref()

      let upstreamRes
      try {
        upstreamRes = await fetch(target, {
          method: req.method,
          headers: { ...baseHeaders, authorization: `Bearer ${key.key}` },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyForModel,
          signal: controller.signal,
        })
      } catch (error) {
        if (timer) clearTimeout(timer)
        lastStatus = 0
        lastText = controller.signal.aborted ? '上游超时' : String(error?.message ?? error)
        // 连不上是线路问题：换线路重试同一个 Key，不占 Key 的尝试次数。
        if (allEndpoints.length > 1) router?.noteEndpoint?.(base, lastText)
        endpointIndex++
        tried.delete(key.id)
        attempts--
        networkFails++
        logger?.warn?.(`modelscope-pool: ${base} 请求失败（${lastText}），换一条线路`)
        if (networkFails >= maxNetworkFails) break
        continue
      }
      if (timer) clearTimeout(timer)

      if (upstreamRes.status >= 200 && upstreamRes.status < 300) {
        pool.markSuccess(key.id)
        pool.stats.ok++
        res.statusCode = upstreamRes.status
        copyHeaders(upstreamRes, res)
        res.setHeader('x-pool-key', key.id)
        if (model) res.setHeader('x-pool-model', model)
        if (upstreamModel) res.setHeader('x-pool-upstream-model', upstreamModel)
        if (key.region) res.setHeader('x-pool-region', key.region)
        if (req.method === 'HEAD' || !upstreamRes.body) {
          res.end()
          return
        }
        const stream = Readable.fromWeb(upstreamRes.body)
        stream.on('error', () => res.destroy())
        stream.pipe(res)
        return
      }

      const text = await upstreamRes.text().catch(() => '')
      lastStatus = upstreamRes.status
      lastText = text

      // 403 没开这个模型、404 模型不存在、400「模型不支持」——都是这个 Key 办不了，
      // 换下一个 Key；Key 本身不停用，换个模型它可能还能用。
      if (modelUnavailable(upstreamRes.status, text) && !quotaLike(text)) {
        pool.stats.failed++
        router?.noteKeyModel?.(model, key.id, `HTTP ${upstreamRes.status}`)
        denied++
        if (denied >= maxDeniedScan) {
          router?.noteModelDead?.(model)
          res.setHeader('retry-after', '300')
          return fail(res, 403, `已连续 ${denied} 个 Key 都拿不到 ${model}，换别的时间或别在面板里恢复全部 Key 再试`, 'model_unavailable')
        }
        continue
      }

      if (CLIENT_STATUS.has(upstreamRes.status) && !quotaLike(text)) {
        // 参数/格式这类问题换 Key 也没用，直接把上游的回答交回去。
        pool.stats.failed++
        res.statusCode = upstreamRes.status
        copyHeaders(upstreamRes, res)
        res.end(text)
        return
      }

      if (DISABLE_STATUS.has(upstreamRes.status) || quotaLike(text)) {
        // 额度用尽停到北京时间次日 00:01；限流/令牌失效冷却 5 分钟。
        const quota = quotaLike(text) || upstreamRes.status === 402
        const reason = quota ? '额度用尽' : reasonOf(upstreamRes.status)
        const untilAt = quota ? nextQuotaResetAt() : undefined
        pool.markFailure(key.id, reason, text.slice(0, 120), untilAt)
        pool.stats.failed++
        const when = quota ? `至北京时间 ${new Date(untilAt + 8 * 3600_000).toISOString().slice(11, 16)}` : '5 分钟'
        logger?.warn?.(`modelscope-pool: key ${key.id} 已停用${when}（${reason}，HTTP ${upstreamRes.status}），换下一个 Key`)
        // 429 可能是「额度真没了」，也可能只是一时抽风：让额度接口把这一把 Key 查到底，
        // 查出来还有额度就立刻放回去，别白白少一个 Key。
        if (upstreamRes.status === 429 || quota) {
          try {
            Promise.resolve(hooks?.quotaSuspect?.(key.id, key.key)).catch(() => {})
          } catch {}
        }
        continue
      }

      // 5xx / 其他：上游故障，换下一个 Key 但不停用当前 Key。
      pool.stats.failed++
      logger?.warn?.(`modelscope-pool: key ${key.id} 上游 ${upstreamRes.status}，换下一个 Key`)
    }

    const status = pool.status()
    if (status.total === 0) return fail(res, 503, '池里还没有 Key：在魔搭复制令牌后点输入框上方的「添加 Key」', 'no_keys')
    if (status.available === 0 && status.cooling > 0) {
      const coolingKeys = status.keys.filter((k) => k.leftMs > 0)
      const least = Math.min(...coolingKeys.map((k) => k.leftMs))
      const sec = Math.max(1, Math.ceil(least / 1000))
      res.setHeader('retry-after', String(sec))
      const quotaOnly = coolingKeys.every((k) => k.reason === '额度用尽')
      const soonest = coolingKeys.reduce((a, b) => (a.leftMs <= b.leftMs ? a : b))
      const at = soonest.untilAt ? new Date(soonest.untilAt + 8 * 3600_000).toISOString().slice(11, 16) : ''
      if (quotaOnly && at) return fail(res, 429, `全部 Key 额度用尽，北京时间 ${at} 自动恢复`, 'all_keys_quota')
      return fail(res, 429, `所有 Key 都在冷却中，约 ${sec} 秒后自动恢复`, 'all_keys_cooling')
    }
    if (lastStatus === 0 && lastText) return fail(res, 502, `所有 Key 都连不上上游（${lastText.slice(0, 80)}）`, 'upstream_unreachable')
    if (lastStatus >= 400 && lastStatus < 600) {
      // 上游故障（5xx 等）：把上游的回答原样交回去，Key 不停用。
      res.statusCode = lastStatus
      let isJson = false
      try {
        JSON.parse(lastText)
        isJson = true
      } catch {}
      res.setHeader('content-type', isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8')
      res.end(lastText || `上游返回 ${lastStatus}`)
      return
    }
    return fail(res, 429, '没有可用的 Key，请稍后再试', 'no_available_key')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        if (!res.headersSent) fail(res, 500, '网关内部出错')
        else res.destroy()
      } catch {}
      logger?.warn?.(`modelscope-pool: ${String(error?.stack ?? error)}`)
    })
  })

  /** 端口被占就顺延；返回实际监听端口。 */
  async function listen() {
    const start = Number(config.port) || 8899
    for (let port = start; port < start + 20; port++) {
      const ok = await new Promise((resolve) => {
        const onError = () => resolve(false)
        server.once('error', onError)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError)
          resolve(true)
        })
      })
      if (ok) {
        boundPort = port
        return port
      }
    }
    throw new Error('8899–8918 都被占用了')
  }

  return {
    listen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    get port() {
      return boundPort
    },
  }
}