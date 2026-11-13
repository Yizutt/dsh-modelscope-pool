// 官方规格：只收录能在模型卡片里找到明确写法的模型，其余不声明，走插件默认。
// 数据来源是 ModelScope 模型卡片（README.md），不是接口字段 —— 魔搭的 /v1/models
// 只回 id / owned_by / created，详情接口也没有上下文字段，所以只能按卡片逐个确认。
//
// 字段含义（DSH 模型发现契约）：
//   contextWindow  请求 + 回复合计的最大上下文
//   maxTokens      最大输出 token 数（仅当卡片明确给出，且明显小于上下文时才填；
//                  两者相等时填了会让 DSH 的压缩预算归零，反而切不过去）
export const OFFICIAL_SPECS = {
  // 卡片表格：Context Length = 1M（正文：both supporting a context length of one million tokens）
  'deepseek-v4-pro': { contextWindow: 1_000_000 },
  // 卡片正文：recommend a maximum output length of 384K tokens
  'deepseek-v4-pro-0813': { contextWindow: 1_000_000, maxTokens: 384 * 1024 },
  // 卡片正文：support for contexts of up to one million tokens
  'deepseek-v4.1-flash': { contextWindow: 1_000_000 },
  // 卡片参数表：context_window = 1M tokens，max_tokens ≥ 256K
  'deepseek-v4.1-flash-1017': { contextWindow: 1_000_000, maxTokens: 256 * 1024 },
  // 卡片正文：Solid 1M Context
  'glm-5.2': { contextWindow: 1_000_000 },
}

/** 按简化名查官方规格（大小写不敏感），查不到返回空对象。 */
export function specFor(name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (!key) return {}
  return OFFICIAL_SPECS[key] ?? {}
}
