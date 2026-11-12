// 多 Key 池：轮换、失败冷却、到点自动恢复。
// 只做内存状态与本地文件读写，不联网。
import { mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'

const COOLDOWN_MS = 5 * 60_000
const CN_OFFSET_MS = 8 * 3600_000
const DAY_MS = 86_400_000

/**
 * 额度用尽后的统一恢复时刻：北京时间最近的一个 00:01:00。
 * 魔搭的额度按自然日（北京时间）重置，留一分钟余量，
 * 避免刚好卡在服务端切换的瞬间又失败一轮。
 */
export function nextQuotaResetAt(now = Date.now()) {
  const cn = now + CN_OFFSET_MS
  const dayStart = Math.floor(cn / DAY_MS) * DAY_MS
  let reset = dayStart + 60_000
  if (reset <= cn) reset = dayStart + DAY_MS + 60_000
  return reset - CN_OFFSET_MS
}

/** 掩码：永远不把完整 Key 交给界面、日志或响应头。 */
export function maskKey(key) {
  const s = String(key ?? '')
  if (s.length <= 6) return '••••'
  return `${s.slice(0, 3)}…${s.slice(-4)}`
}

export class KeyPool {
  constructor({ dir, cooldownMs = COOLDOWN_MS, logger }) {
    this.dir = dir
    this.keysFile = join(dir, 'keys.json')
    this.coolFile = join(dir, 'cooldowns.json')
    this.cooldownMs = cooldownMs
    this.logger = logger
    this.keys = []
    this.states = new Map() // id -> { until, fails, lastReason, lastError, used, ok }
    this.cursor = 0
    this.stats = { requests: 0, ok: 0, failed: 0, failovers: 0 }
    this.onChange = null
    this._lastCooldownCount = 0
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await this.reload()
    await this._loadCool()
    return this
  }

  /**
   * 冷却状态落盘：额度用尽的 Key 要停到次日 00:01，
   * 引擎重启（App 每次冷启动都会重启）后不能又拿它去撞墙。
   */
  async _loadCool() {
    try {
      const raw = JSON.parse(await readFile(this.coolFile, 'utf8'))
      const now = Date.now()
      for (const [id, v] of Object.entries(raw ?? {})) {
        const st = this.states.get(id)
        const until = Number(v?.until) || 0
        if (!st || until <= now) continue
        st.until = until
        st.lastReason = String(v?.reason ?? '额度用尽').slice(0, 24)
      }
    } catch {}
  }

  async _saveCool() {
    const now = Date.now()
    const out = {}
    for (const [id, st] of this.states) {
      if (st.until > now) out[id] = { until: st.until, reason: st.lastReason }
    }
    try {
      await writeFile(this.coolFile, JSON.stringify(out, null, 1) + '\n', { mode: 0o600 })
    } catch {}
  }

  async reload() {
    try {
      const raw = JSON.parse(await readFile(this.keysFile, 'utf8'))
      const list = Array.isArray(raw?.keys) ? raw.keys : []
      this.keys = list
        .filter((k) => k && typeof k.key === 'string' && k.key.length >= 8)
        .map((k, i) => ({
          id: typeof k.id === 'string' && k.id ? k.id : `k${i + 1}`,
          key: k.key,
          label: typeof k.label === 'string' ? k.label.slice(0, 24) : '',
          region: k.region === 'ai' || k.region === 'cn' ? k.region : '',
          addedAt: Number(k.addedAt) || 0,
        }))
    } catch {
      this.keys = []
    }
    this.keys.forEach((k) => {
      if (!this.states.has(k.id)) this.states.set(k.id, { until: 0, fails: 0, lastReason: '', lastError: '', used: 0, ok: 0 })
    })
    for (const id of [...this.states.keys()]) if (!this.keys.some((k) => k.id === id)) this.states.delete(id)
    return this.keys.length
  }

  async _save() {
    const body = JSON.stringify({ keys: this.keys }, null, 2) + '\n'
    await writeFile(this.keysFile, body, { mode: 0o600 })
    try {
      await chmod(this.keysFile, 0o600)
    } catch {}
  }

  has(key) {
    return this.keys.some((k) => k.key === key)
  }

  /** 认出 Key 的版本后写回 keys.json；版本变了（比如换站点后）也能改。 */
  async setRegion(id, region) {
    const key = this.keys.find((k) => k.id === id)
    if (!key || (region !== 'ai' && region !== 'cn')) return false
    if (key.region === region) return false
    key.region = region
    await this._save()
    return true
  }

  async add(rawKey, label = '', region = '') {
    const key = String(rawKey ?? '').trim()
    if (key.length < 16) return { ok: false, error: 'Key 太短，看起来不像魔搭令牌' }
    if (this.has(key)) return { ok: false, error: '这个 Key 已经在池里了' }
    let id = `k${this.keys.length + 1}`
    let n = this.keys.length + 1
    while (this.keys.some((k) => k.id === id)) id = `k${++n}`
    this.keys.push({
      id,
      key,
      label: String(label ?? '').slice(0, 24),
      region: region === 'ai' || region === 'cn' ? region : '',
      addedAt: Date.now(),
    })
    this.states.set(id, { until: 0, fails: 0, lastReason: '', lastError: '', used: 0, ok: 0 })
    await this._save()
    this._notify()
    return { ok: true, id }
  }

  async remove(id) {
    const before = this.keys.length
    this.keys = this.keys.filter((k) => k.id !== id)
    this.states.delete(id)
    void this._saveCool()
    if (this.keys.length === before) return false
    await this._save()
    this._notify()
    return true
  }

  /** 让某个 Key 立刻恢复可用（额度查明后又涨回去了、或手动点了恢复）。 */
  restore(id) {
    const st = this.states.get(id)
    if (!st) return false
    const was = st.until > 0 || Boolean(st.lastReason)
    st.until = 0
    st.lastReason = ''
    st.lastError = ''
    st.manual = false
    if (was) {
      void this._saveCool()
      this._notify()
    }
    return was
  }

  async restoreAll() {
    for (const st of this.states.values()) {
      st.until = 0
      st.lastReason = ''
      st.manual = false
    }
    void this._saveCool()
    this._notify()
  }

  _notify() {
    try {
      this.onChange?.()
    } catch {}
  }

  /** 到期自动恢复：任何一次取状态或取 Key 都会顺手清理。 */
  _expire() {
    let cooling = 0
    const now = Date.now()
    for (const st of this.states.values()) {
      if (st.until && st.until <= now) {
        st.until = 0
        st.lastReason = ''
      }
      if (st.until > now) cooling++
    }
    return cooling
  }

  available() {
    this._expire()
    const now = Date.now()
    return this.keys.filter((k) => !(this.states.get(k.id)?.until > now))
  }

  /** 轮询取下一个可用 Key；exclude 用于同一次请求里不重复试同一个。 */
  pick(exclude) {
    const pool = this.available().filter((k) => !exclude?.has(k.id))
    if (pool.length === 0) return null
    const key = pool[this.cursor % pool.length]
    this.cursor = (this.cursor + 1) % Math.max(1, pool.length)
    return key
  }

  markSuccess(id) {
    const st = this.states.get(id)
    if (!st) return
    st.used++
    st.ok++
    const wasCooling = st.until > 0
    st.until = 0
    st.lastReason = ''
    st.lastError = ''
    if (wasCooling) void this._saveCool()
  }

  /**
   * 停用一个 Key。untilAt 给了就按它恢复（额度用尽 → 次日 00:01），
   * 否则退回常规冷却。
   */
  /**
   * 手动禁用：一直停用到点了「恢复」为止。
   * 用 far-until + manual 标记，额度巡检也不会把它自动放开。
   */
  disable(id, reason = '手动禁用') {
    const st = this.states.get(id)
    if (!st) return false
    st.until = Date.now() + 100 * 365 * 24 * 3600_000
    st.lastReason = reason
    st.lastError = ''
    st.manual = true
    void this._saveCool()
    this._notify()
    return true
  }

  /** 手动停用：按给定时间自动恢复（额度类 → 次日 00:01）。 */
  async stop(id, reason = '手动停用', untilAt) {
    const st = this.states.get(id)
    if (!st) return false
    st.until = Number(untilAt) > Date.now() ? Number(untilAt) : Date.now() + this.cooldownMs
    st.lastReason = reason
    st.lastError = ''
    st.manual = false
    void this._saveCool()
    this._notify()
    return true
  }

  markFailure(id, reason, error = '', untilAt) {
    const st = this.states.get(id)
    if (!st) return 0
    const now = Date.now()
    const explicit = Number(untilAt) || 0
    st.fails++
    st.used++
    st.until = explicit > now ? explicit : now + this.cooldownMs
    st.lastReason = reason
    st.lastError = String(error ?? '').slice(0, 120)
    void this._saveCool()
    this._notify()
    return st.until
  }

  status() {
    const cooling = this._expire()
    const now = Date.now()
    const items = this.keys.map((k) => {
      const st = this.states.get(k.id) ?? {}
      const left = st.until > now ? st.until - now : 0
      return {
        id: k.id,
        masked: maskKey(k.key),
        label: k.label,
        region: k.region ?? '',
        state: left > 0 ? 'cooling' : 'ok',
        leftMs: left,
        untilAt: left > 0 ? st.until : 0,
        fails: st.fails ?? 0,
        used: st.used ?? 0,
        reason: st.lastReason ?? '',
        lastError: st.lastError ?? '',
        manual: st.manual === true,
      }
    })
    return {
      total: items.length,
      available: items.filter((k) => k.state === 'ok').length,
      cooling,
      keys: items,
      stats: { ...this.stats },
    }
  }

  /** 后台心跳：冷却到点自动恢复；有人手改 keys.json 也会被读进来。 */
  startWatch(getRefresh) {
    let lastMtime = 0
    const checkFile = async () => {
      try {
        const info = await stat(this.keysFile)
        const mtime = Number(info.mtimeMs) || 0
        if (mtime && mtime !== lastMtime) {
          lastMtime = mtime
          await this.reload()
          getRefresh?.()
        }
      } catch {}
    }
    const fileTimer = setInterval(checkFile, 4000)
    const coolTimer = setInterval(() => {
      const cooling = this._expire()
      const changed = cooling !== this._lastCooldownCount
      this._lastCooldownCount = cooling
      if (changed) getRefresh?.()
    }, 20_000)
    if (typeof fileTimer.unref === 'function') fileTimer.unref()
    if (typeof coolTimer.unref === 'function') coolTimer.unref()
    return () => {
      clearInterval(fileTimer)
      clearInterval(coolTimer)
    }
  }
}