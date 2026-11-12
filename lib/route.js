// Key 级无感路由：模型始终是客户端要的那个，变的只是用哪个 Key 去请求。
// 某个 Key 限流、额度不足、没开这个模型（403）、模型不存在（404）——
// 都算「这个 Key 现在办不了这件事」，静默换下一个 Key 重试，客户端只看到最终结果。
//
// 为了让第二次不再从第一个 Key 重新撞一遍，这里记住「哪个 Key 拿不到哪个模型」，
// 5 分钟内同一模型直接跳过这些 Key；Key 本身不做全局停用（别处它可能还能用）。
const BLOCK_TTL = 5 * 60_000

// 上游明确表示「这个模型我这儿没有 / 你没权限」的语气。
const UNAVAILABLE =
  /(has no provider supported|model[_\s-]?not[_\s-]?(found|supported|available)|does\s+not\s+exist|not\s+found|no\s+access|not\s+authori[sz]ed|permission\s+denied|unsupported\s+model|invalid\s+model|model\s+does\s+not|无权|不存在|没有权限)/i

/** 这次失败是「这个 Key 拿不到这个模型」（换 Key），还是「请求参数本身不对」（原样返回）？ */
export function modelUnavailable(status, text) {
  if (status === 403 || status === 404) return true
  if (status === 400 || status === 422) return UNAVAILABLE.test(String(text ?? ''))
  return false
}

export function createRouter({ logger } = {}) {
  /** `model|keyId` -> 到期时间。 */
  const blocked = new Map()
  /** 上游线路 -> 到期时间（连不上的线路暂时绕开）。 */
  const badEndpoints = new Map()
  /** 模型 -> 到期时间：扫了一圈 Key 都没权限，就先整体标记，别让每次请求都重扫。 */
  const deadModels = new Map()

  const prune = () => {
    const now = Date.now()
    for (const [pair, until] of blocked) if (until <= now) blocked.delete(pair)
  }

  const pairOf = (model, keyId) => `${model}\u0000${keyId}`

  /** 这个模型上已知办不了的 Key，用来在重试时直接跳过。 */
  function blockedKeys(model) {
    const want = String(model ?? '')
    if (!want) return []
    prune()
    const out = []
    for (const pair of blocked.keys()) {
      const at = pair.indexOf('\u0000')
      if (pair.slice(0, at) === want) out.push(pair.slice(at + 1))
    }
    return out
  }

  /** 记下「这个 Key 拿不到这个模型」，5 分钟内不再用它试。 */
  function noteKeyModel(model, keyId, reason = '') {
    if (!model || !keyId) return
    blocked.set(pairOf(model, keyId), Date.now() + BLOCK_TTL)
    logger?.warn?.(`modelscope-pool: key ${keyId} 暂不用于 ${model}（${String(reason).slice(0, 40)}），换下一个 Key`)
  }

  /** 某个 Key 恢复可用（比如手动恢复全部）时，把它从所有模型的屏蔽表里摘掉。 */
  function clearKey(keyId) {
    for (const pair of [...blocked.keys()]) {
      if (pair.slice(pair.indexOf('\u0000') + 1) === keyId) blocked.delete(pair)
    }
  }

  function clearAll() {
    blocked.clear()
  }

  /** 这条上游线路还通不通。 */
  function endpointOk(endpoint) {
    const until = badEndpoints.get(endpoint)
    if (!until) return true
    if (until > Date.now()) return false
    badEndpoints.delete(endpoint)
    return true
  }

  function noteEndpoint(endpoint, reason = '') {
    if (!endpoint) return
    badEndpoints.set(endpoint, Date.now() + BLOCK_TTL)
    logger?.warn?.(`modelscope-pool: 上游 ${endpoint} 连不上（${String(reason).slice(0, 40)}），暂时换线路`)
  }

  /** 这个模型是不是刚被确认「所有 Key 都办不了」。 */
  function modelDead(model) {
    const until = deadModels.get(model)
    if (!until) return false
    if (until > Date.now()) return true
    deadModels.delete(model)
    return false
  }

  function noteModelDead(model) {
    if (!model) return
    deadModels.set(model, Date.now() + BLOCK_TTL)
    logger?.warn?.(`modelscope-pool: ${model} 扫完一圈 Key 都拿不到，${BLOCK_TTL / 60000} 分钟内直接返回错误`)
  }

  function snapshot() {
    prune()
    for (const [ep, until] of badEndpoints) if (until <= Date.now()) badEndpoints.delete(ep)
    for (const [m, until] of deadModels) if (until <= Date.now()) deadModels.delete(m)
    return { blockedPairs: blocked.size, badEndpoints: [...badEndpoints.keys()], deadModels: [...deadModels.keys()] }
  }

  return { blockedKeys, noteKeyModel, clearKey, clearAll, endpointOk, noteEndpoint, modelDead, noteModelDead, snapshot }
}