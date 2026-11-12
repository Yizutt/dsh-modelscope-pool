// 模型目录：国际版（api-inference.modelscope.ai）与国内版（api-inference.modelscope.cn）
// 各有一份模型表，两边取并集并按「简化名」合并：同一个模型在两个站点的 id 可能不同
// （例如 zai-org/GLM-4.7-Flash 与 ZhipuAI/GLM-4.7-Flash），合并后只出现一行，
// 真正请求时按 Key 所属站点换成那边的真实 id。
const REGION_LABEL = { ai: '国际版', cn: '国内版' }

/**
 * 简化名只去掉厂商前缀，其它字符原样保留：
 * `deepseek-ai/DeepSeek-V4.1-Flash-1017` → `DeepSeek-V4.1-Flash-1017`。
 * 版本号里的 .1 是模型身份的一部分，绝不能吞掉。
 */
export function simplifyModelId(id) {
  const text = String(id ?? '').trim()
  return text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text
}

export function createCatalog({ regions, preferred = ['ai', 'cn'], ttlMs = 300_000, timeoutMs = 15_000 } = {}) {
  let cache = { at: 0, entries: [] }

  const sites = () =>
    preferred
      .map((key) => ({ region: key, base: String(regions?.[key]?.inference ?? '').replace(/\/+$/, '') }))
      .filter((row) => row.base.length > 0)

  const fetchOne = async (base) => {
    try {
      const res = await fetch(`${base}/models`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      const body = await res.json().catch(() => undefined)
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
      return rows
        .map((row) => String(row?.id ?? '').trim())
        .filter((id) => id.length > 0 && id.length <= 120 && !id.includes(' '))
    } catch {
      return []
    }
  }

  return {
    get entries() {
      return cache.entries
    },
    get ids() {
      return cache.entries.map((row) => row.id)
    },
    get updatedAt() {
      return cache.at
    },
    regionLabel: (region) => REGION_LABEL[region] ?? '未知站点',

    async list({ force = false } = {}) {
      if (!force && cache.entries.length > 0 && Date.now() - cache.at < ttlMs) return cache.entries

      const merged = new Map()
      for (const { region, base } of sites()) {
        const ids = await fetchOne(base)
        for (const raw of ids) {
          const name = simplifyModelId(raw)
          if (!name) continue
          const slot = name.toLowerCase()
          const row = merged.get(slot) ?? { name, variants: {}, rawIds: [] }
          if (!row.rawIds.includes(raw)) row.rawIds.push(raw)
          // 同一个站点里同名的，保留第一个（通常是主推的 org）。
          if (!row.variants[region]) row.variants[region] = raw
          merged.set(slot, row)
        }
        if (sites().length > 1) await new Promise((resolve) => setTimeout(resolve, 300))
      }

      if (merged.size > 0) {
        const entries = [...merged.values()]
          .map((row) => ({
            id: row.name,
            name: row.name,
            regions: preferred.filter((key) => Boolean(row.variants[key])),
            variants: row.variants,
            rawIds: row.rawIds,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
        cache = { at: Date.now(), entries }
      }
      return cache.entries
    },

    /** 客户端给的名字（简化名 / 上游 id / 大小写不同）找到目录里的那一项。 */
    resolve(text) {
      const needle = String(text ?? '').trim().toLowerCase()
      if (!needle) return undefined
      return (
        cache.entries.find((row) => row.id.toLowerCase() === needle) ??
        cache.entries.find((row) => row.rawIds.some((raw) => raw.toLowerCase() === needle))
      )
    },

    /** 这个站点该用哪个上游 id：有本站点变体就用它，没有就退回任意一个。 */
    modelFor(text, region) {
      const group = this.resolve(text)
      if (!group) return ''
      return group.variants?.[region] ?? group.variants?.[preferred[0]] ?? group.rawIds[0] ?? ''
    },

    regionOf(id) {
      return this.resolve(id)?.regions ?? []
    },
  }
}