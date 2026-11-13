/**
 * 界面多语言：跟随 App 的语言（`caps.locale` / `event.locale`），缺省按系统语言判断。
 *
 * 约定：中文用「国际版 / 国内版」，其他语言用「International / China」。
 * 站点名、失败原因这类存盘的字符串保持中文常量，显示时再翻译，
 * 这样 keys.json / cooldowns.json 的数据不受语言影响。
 */

const S = {
  // 面板标题
  poolTitle: ['魔搭 Key 池', 'ModelScope keys'],
  keyPanelTitle: ['Key 详情', 'Key detail'],
  modelsPanelTitle: ['魔搭模型', 'ModelScope models'],

  // 概览
  metricReady: ['可用', 'Ready'],
  metricCooling: ['冷却', 'Cooling'],
  metricMagicubes: ['魔粒', 'Magicubes'],

  // 按钮
  btnPrev: ['上一页', 'Prev'],
  btnNext: ['下一页', 'Next'],
  btnRefresh: ['刷新额度', 'Refresh quota'],
  btnTestAll: ['测试全部', 'Test all'],
  btnRestoreAll: ['全部恢复', 'Restore all'],
  btnDisable: ['禁用', 'Disable'],
  btnStop: ['停用', 'Pause'],
  btnRestore: ['恢复', 'Restore'],
  btnDelete: ['删除', 'Delete'],
  btnBack: ['返回 Key 列表', 'Back to keys'],
  btnReloadModels: ['重新拉取模型', 'Reload models'],
  formSubmit: ['添加', 'Add'],
  fieldLabel: ['添加 Key', 'Add key'],
  fieldPlaceholder: ['粘贴 ms- 开头的令牌，可多行', 'Paste ms- tokens, one per line'],

  // 提示
  hintNoKeys: [
    '还没有 Key：在魔搭复制令牌（ms- 开头）后点输入框上方的「添加 Key」，也可以在下面直接填。',
    'No keys yet. Copy a token that starts with ms- on ModelScope, then tap "Add key" above the composer — or paste it below.',
  ],
  hintCooling: [
    '无感切换已开：剩余魔粒低于 2 的 Key 已自动停用到次日 00:01，避免撞 429。到点自动恢复。',
    'Silent rotation is on. Keys with fewer than 2 magicubes are paused until 00:01 next day to avoid 429s, and resume automatically.',
  ],
  hintModel: [
    '无感切换已开：模型始终是 {model}，Key 遇到限流、额度不足、没权限会自动换下一个；魔粒低于 2 的 Key 会提前停用。',
    'Silent rotation is on. The model stays {model}; on rate limits, exhausted quota or missing permission the gateway moves to the next key. Keys under 2 magicubes are paused early.',
  ],
  hintIdle: [
    '点「刷新额度」看剩余魔粒；点下面的模型可以设为默认。',
    'Tap "Refresh quota" to check remaining magicubes; tap a model below to set it as default.',
  ],
  routed: [
    '已记下 {n} 个「Key×模型」的失败组合（5 分钟内自动跳过）。',
    '{n} key/model failures remembered and skipped for 5 minutes.',
  ],
  hintKeyDetail: [
    '「禁用」= 一直停到点恢复；「停用」= 停到北京时间次日 00:01；「删除」会把令牌从本机文件里去掉。',
    '"Disable" keeps the key off until you restore it; "Pause" stops it until 00:01 next day (Beijing time); "Delete" removes the token from this device.',
  ],
  hintKeyFallback: [
    '回到「魔搭 Key 池」面板，点列表里任意一行就会选中它。',
    'Go back to the key list and tap a row to select it.',
  ],

  // 扇形图
  bucketReady: ['可用', 'Ready'],
  bucketLow: ['额度不足', 'Out of quota'],
  bucketInvalid: ['令牌无效', 'Invalid token'],
  bucketOther: ['其他冷却', 'Cooling (other)'],
  unitKey: ['个', ''],
  captionNoKeys: ['还没有 Key', 'No keys yet'],
  shareTitle: ['Key 状态分布', 'Key status'],
  magicLabel: ['魔粒用量', 'Magicube usage'],
  magicBarCaption: ['剩余 {left} / 共 {total}', '{left} left of {total}'],
  magicLeft: ['剩余', 'Remaining'],
  magicUsed: ['已用', 'Spent'],
  magicCaption: [
    '共 {total} 魔粒（{keys} 个 Key × {per}）；剩余 {left}，已用 {used}。未查到的 Key 按满额计。',
    '{total} magicubes total ({keys} keys × {per}); {left} left, {used} spent. Keys not checked yet count as full.',
  ],
  magicCaptionEmpty: ['还没有 Key，估不出总魔粒', 'No keys yet, so the magicube total is unknown'],
  captionTotal: [
    '共 {total} 个 Key：可用 {ok}，额度不足 {low}，其余冷却中',
    '{total} keys: {ok} ready, {low} out of quota, the rest cooling down',
  ],

  // Key 列表
  keyTitleEmpty: ['Key 池（还没有 Key）', 'Key pool (empty)'],
  keyTitlePage: [
    'Key 池 {total} 个 · 第 {page}/{pages} 页（点一行看详情）',
    '{total} keys · page {page}/{pages} (tap a row for detail)',
  ],
  keyPager: ['第 {page}/{pages} 页 · 每页 {size} 个', 'Page {page}/{pages} · {size} per page'],
  usedTimes: ['用过 {n} 次', 'used {n}×'],
  quotaLeft: ['额度 {n} 魔粒', '{n} magicubes'],
  quotaUnknown: ['额度未知（{error}）', 'quota unknown ({error})'],
  quotaUnchecked: ['额度未查', 'quota not checked'],
  selectedMark: ['（已选中）', ' (selected)'],
  failTimes: ['失败 {n} 次', '{n} failed'],
  stateReady: ['可用', 'Ready'],
  stateDisabled: ['已禁用', 'Disabled'],
  coolingUntil: ['冷却至 {time}', 'cooling until {time}'],
  coolingLeft: ['冷却 {time}', 'cooling {time}'],

  // Key 详情
  focusEmpty: ['还没选中 Key（回「Key 列表」点一行）', 'No key selected — tap a row in the key list'],
  rowToken: ['完整令牌', 'Full token'],
  rowSite: ['站点', 'Site'],
  rowQuota: ['额度', 'Quota'],
  rowState: ['状态', 'State'],
  rowFails: ['失败', 'Failures'],
  quotaDetail: ['{n} 魔粒（总额 {total}，冻结 {frozen}）', '{n} magicubes (total {total}, frozen {frozen})'],
  quotaFailed: ['查询失败：{error}', 'lookup failed: {error}'],
  quotaNever: ['还没查过', 'not checked yet'],
  stateManual: ['已禁用（点「恢复」放开）', 'Disabled — tap "Restore" to re-enable'],
  failsDetail: ['{n} 次 · {error}{used}', '{n}× · {error}{used}'],
  usedSuffix: [' · 用过 {n} 次', ' · used {n}×'],
  none: ['无', 'none'],

  // 模型列表
  modelsTitleEmpty: ['模型（还没读到，点下面「重新拉取模型」）', 'Models (not loaded — tap "Reload models")'],
  modelsTitleCount: ['{n} 个模型 · 当前 {current}', '{n} models · current {current}'],
  modelNotPicked: ['未选', 'none'],
  groupCount: ['{n} 个模型', '{n} models'],
  groupBoth: ['国际版 + 国内版都有', 'On both sites'],
  groupUnknown: ['站点未知', 'Unknown site'],
  currentDefault: ['当前默认', 'current default'],
  trailingCurrent: ['当前', 'Current'],
  trailingUse: ['使用', 'Use'],

  // 操作反馈
  toastQuotaUpdated: ['额度已更新', 'Quota refreshed'],
  toastModelSet: ['默认模型：{model}', 'Default model: {model}'],
  toastModelBad: ['模型名不可用', 'That model name is not usable'],
  toastNoKeys: ['池里还没有 Key', 'The pool has no keys'],
  toastTestDone: ['测试完成：{parts}', 'Test done: {parts}'],
  partOk: ['{ok}/{total} 个 Key 可用', '{ok}/{total} keys ready'],
  partShort: ['{n} 个额度不足', '{n} out of quota'],
  partInvalid: ['{n} 个令牌无效', '{n} invalid'],
  toastRestored: ['已把全部 Key 恢复为可用', 'All keys restored'],
  toastNoPick: ['先在上面点一行选中一个 Key', 'Select a key from the list first'],
  toastNoKeyId: ['没认出这个 Key', 'Could not identify that key'],
  toastDisabled: ['{id} 已禁用，点「恢复」才放开', '{id} disabled — tap "Restore" to re-enable'],
  toastStopped: ['{id} 停用到北京时间次日 00:01', '{id} paused until 00:01 next day (Beijing time)'],
  toastRestoredOne: ['{id} 已恢复可用', '{id} is ready again'],
  toastDeleteArm: ['再点一次「删除」确认删掉 {id}', 'Tap "Delete" once more to remove {id}'],
  toastDeleted: ['{id} 已从本机删除', '{id} removed from this device'],
  toastFirstPage: ['已经是第一页了', 'Already on the first page'],
  toastLastPage: ['已经是最后一页了', 'Already on the last page'],
  toastModelsReloaded: ['模型列表已重新拉取', 'Model list reloaded'],
  toastNoClipboard: ['剪贴板里没有文字', 'Nothing to read in the clipboard'],
  toastNoInput: ['没读到 Key', 'No key found in the input'],
  toastNotMs: ['这不像魔搭令牌（应以 ms- 开头）', 'That does not look like a ModelScope token (should start with ms-)'],
  toastNoNew: ['没有新增 Key', 'No new keys added'],

  // 添加结果
  addDone: ['新增 {n} 个', '{n} added'],
  addIntl: ['国际版 {n}', 'International {n}'],
  addCn: ['国内版 {n}', 'China {n}'],
  addLow: ['{n} 个额度不足已停用', '{n} out of quota, paused'],
  addInvalid: ['{n} 个令牌无效', '{n} invalid'],
  addSkipped: ['{n} 个重复跳过', '{n} duplicates skipped'],
  joinArrow: ['｜', ' · '],

  // 状态条
  stripEmpty: ['魔搭 未配置', 'ModelScope · none'],
  stripText: ['魔搭 {ok}/{total} · {quota}', 'ModelScope {ok}/{total} · {quota}'],
  stripQuota: ['{n} 魔粒', '{n} left'],
  stripQuotaUnknown: ['额度?', 'quota?'],

  // 站点与原因
  regionAi: ['国际版', 'International'],
  regionCn: ['国内版', 'China'],
  regionUnknown: ['版本未知', 'Unknown site'],
}

const REASONS = {
  额度不足: ['额度不足', 'Out of quota'],
  额度用尽: ['额度用尽', 'Quota exhausted'],
  令牌无效: ['令牌无效', 'Invalid token'],
  被限流: ['被限流', 'Rate limited'],
  模型名不可用: ['模型名不可用', 'Model unavailable'],
  上游超时: ['上游超时', 'Upstream timeout'],
  读取请求失败: ['读取请求失败', 'Request failed'],
  冷却中: ['冷却中', 'Cooling down'],
  手动禁用: ['手动禁用', 'Disabled manually'],
  手动停用: ['手动停用', 'Paused manually'],
  其他冷却: ['其他冷却', 'Cooling (other)'],
}

/** 系统语言判断：App 没给 locale 时的兜底。 */
export function detectLang() {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale
    if (locale) return String(locale).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {}
  const env = String(process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? '')
  if (env) return env.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return 'zh'
}

/** `zh-Hans-CN` / `en-US` / 空 → `'zh'` | `'en'`。 */
export function pickLang(locale) {
  const raw = String(locale ?? '').trim()
  if (!raw) return detectLang()
  return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * 造一个翻译函数：`t('key', { n: 3 })`，另带 `t.lang`、`t.region(r)`、`t.reason(r)`。
 */
export function makeT(locale) {
  const lang = pickLang(locale)
  const idx = lang === 'en' ? 1 : 0
  const t = (key, vars) => {
    const row = S[key]
    let text = row ? row[idx] : key
    if (vars) {
      for (const k of Object.keys(vars)) text = text.split(`{${k}}`).join(String(vars[k]))
    }
    return text
  }
  t.lang = lang
  t.region = (region) =>
    region === 'ai' ? t('regionAi') : region === 'cn' ? t('regionCn') : t('regionUnknown')
  t.reason = (reason) => {
    const text = String(reason ?? '')
    const row = REASONS[text]
    return row ? row[idx] : text
  }
  return t
}