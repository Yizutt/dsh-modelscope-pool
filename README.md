# dsh-modelscope-pool

[![npm](https://img.shields.io/npm/v/dsh-modelscope-pool.svg)](https://www.npmjs.com/package/dsh-modelscope-pool)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-4D6BFE.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/node-%3E%3D20-5FA04E.svg)](https://nodejs.org/)

**魔搭（ModelScope）多 Key 聚合网关**：把十几个、几十个魔搭 API Key 拼成一个 OpenAI 兼容接口。当前 Key 遇到限流、额度不足、无权限或令牌失效时，**自动无感换下一个 Key**，模型始终不变。

同时它是 [DSH](https://github.com/deepseek-ai/deepseek-harness) / dsh-go 的原生插件：在手机 App 里直接看额度、管 Key、选模型，不需要另开网页。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

---

## 目录

- [特性](#特性)
- [它是怎么工作的](#它是怎么工作的)
- [安装](#安装)
- [配置](#配置)
- [界面](#界面)
- [多语言](#多语言)
- [网页版与桌面版](#网页版与桌面版)
- [模型上下文与最大输出](#模型上下文与最大输出)
- [HTTP 接口](#http-接口)
- [接入其它客户端](#接入其它客户端)
- [常见问题](#常见问题)
- [安全说明](#安全说明)
- [开发](#开发)
- [License](#license)

---

## 特性

### 无感路由：只换 Key，不换模型

你请求 `DeepSeek-V4.1-Flash-1017`，拿到的永远是 `DeepSeek-V4.1-Flash-1017`。网关只是在背后换一个还能用的 Key 重发。

| 上游返回 | 网关的判断 | 处理方式 |
|---|---|---|
| `401` / 令牌无效 | 这个 Key 废了 | 冷却 5 分钟后重试 |
| `402` / `429` + 额度文案 | 额度真的用完了 | 停用到**北京时间次日 00:01**自动恢复 |
| `429` 限流（无额度文案） | 只是被限流 | 冷却 5 分钟，并对这个 Key 反复刷新额度直到刷出数字 |
| `403` / `404` / `400` 无此模型 | 这个 Key 没权限，不是坏了 | 只拉黑「Key × 模型」组合 5 分钟，Key 本身照用 |
| 网络错误 / 超时 | 线路问题 | 换备用线路或下一个 Key |

### 自动识别国际版 / 国内版

`.ai` 和 `.cn` 是两套独立的账号体系，令牌不通用。导入 Key 时会用**扣费为零**的额度接口（`/magicubes/balance`）探测它属于哪个站点，并记住结果：

- 国际版 Key → 走 `https://api-inference.modelscope.ai/v1`
- 国内版 Key → 走 `https://api-inference.modelscope.cn/v1`

**不工作**的做法：用 `/v1/models` 验令牌——那个接口是公开的，任何（甚至伪造的）令牌都返回 200。

### 模型表实时合并两个站点

面板和 `/v1/models` 的模型来自两个站点实时拉取的推理目录，按「去掉厂商前缀后的名字」合并：

| 展示名 | 国际版真实 id | 国内版真实 id |
|---|---|---|
| `GLM-4.7-Flash` | `zai-org/GLM-4.7-Flash` | `ZhipuAI/GLM-4.7-Flash` |
| `DeepSeek-V4.1-Flash-1017` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | — |

同一个模型只显示一行；请求时按当前 Key 所属站点自动换成那边的真实 id。版本号（`.1`、`-0813`、`-1017`）是模型身份的一部分，**原样保留**。

### 界面跟随系统语言

面板、按钮、提示、状态条、模型页里的站点后缀都跟随 App 的语言：

| 语言 | 站点叫法 |
|---|---|
| 中文 | 国际版 / 国内版 |
| 其他语言 | International / China |

中文以外的语言不会出现「Domestic」「Mainland」这类别扭说法。存盘的 `keys.json`、`cooldowns.json` 里仍然是语言无关的常量，换语言不会动到数据。

### 额度保护

- 剩余魔粒（ModelScope 的额度单位）**低于 2** 时，Key 自动停用到次日 00:01，避免无谓的 `429`。
- 每 5 分钟批量刷新一次额度；单个 Key 出现 `429` 时，按 0/5/10/20/40/60/90/120 秒退避单独重刷，直到刷出数字为止。
- 手动禁用（`manual`）的 Key 不会被自动恢复流程放开，必须手动点「恢复」。

### 单 Key 全生命周期管理

禁用 / 停用到次日 / 恢复 / 删除，逐条可见：令牌掩码、所属站点、剩余额度、状态、最近一次失败原因、已用次数。

---

## 它是怎么工作的

```
客户端（DSH / Cherry Studio / 任何 OpenAI 客户端）
        │  Authorization: Bearer <网关自己的占位密钥>
        ▼
127.0.0.1:8899  ──────────────────────────────────────
   /v1/chat/completions
        │
        ├─ 模型名解析（简化名 / 真实 id 都认）
        ├─ 按 Key 所属站点算真实上游 id
        ├─ 选一个可用 Key（跳过冷却、停用、被手动禁用的）
        ▼
   https://api-inference.modelscope.ai|cn/v1
        │
        ├─ 200 → 透传；响应头标注用了哪个 Key
        └─ 失败 → 分类（换 Key / 停用到次日 / 拉黑组合）→ 重试
```

一次请求最多把池里的 Key 都轮一遍（「这个 Key 没开通该模型」的扫描另有 24 次上限），客户端只会看到一次结果。

---

## 安装

### 前置条件

- Node.js ≥ 20
- 一个魔搭账号和它的 API Key（`ms-` 开头），在 <https://modelscope.cn/my/myaccesstoken> 或 <https://modelscope.ai> 生成

### 方式一：从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-modelscope-pool@0.11.0
```

一条命令搞定。装好后重启 App（或让插件重新加载），网关会在 `127.0.0.1:8899` 起来。

升级就是换版本号重装：

```bash
dsh plugin --profile web add dsh-modelscope-pool@<新版本>
```

> 建议写死精确版本。npm 上其他包常见的 `latest`、`^` 范围在这里没有好处——插件会监听端口、读写本机文件，版本变化值得你自己看一眼。

只想要包本身、不需要 dsh 帮你装：

```bash
npm i dsh-modelscope-pool
```

> 每个版本的改动见 [Releases](https://github.com/Yizutt/dsh-modelscope-pool/releases)。

### 方式二：从源码安装（要改代码时用）

```bash
# 目录名要和 package.json 的 name 一致
mkdir -p "$DSH_HOME/dsh-go/plugins"
cd "$DSH_HOME/dsh-go/plugins"
git clone https://github.com/Yizutt/dsh-modelscope-pool.git dsh-modelscope-pool

dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/dsh-modelscope-pool"
```

装的是指向这个目录的链接，所以**目录不能删**。改完 `lib/` 里的代码需要在 App 的「引擎」页重启引擎才生效。

### 方式三：只挂到 Harness（网页版 / 桌面版）

插件本身就是一个 Cordis bundle（`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），所以不装 dsh-go 也能用：

```bash
dsh plugin --profile web add /path/to/dsh-modelscope-pool
```

网页版的管理页在 `http://127.0.0.1:3080/modelscope-pool`，见[网页版与桌面版](#网页版与桌面版)。

---

## 配置

首次启动会自动在 `$DSH_HOME/modelscope-pool/` 下创建：

| 文件 | 内容 | 权限 |
|---|---|---|
| `config.json` | 端口、冷却时长、上游地址 | `0600` |
| `keys.json` | 你的所有 Key | `0600` |
| `cooldowns.json` | 冷却与停用状态 | `0600` |

`config.json` 的全部字段（都有默认值，通常不用手改）：

```jsonc
{
  "port": 8899,                                       // 网关监听端口
  "cooldownMs": 300000,                               // 临时失败的冷却时长（5 分钟）
  "timeoutMs": 120000,                                // 单次上游请求超时
  "upstream": "https://api-inference.modelscope.ai/v1", // 主线路
  "upstreams": [],                                    // 备用线路（主线路连不上时自动换）
  "apiKey": "",                                       // 网关自己的占位密钥，留空则不校验
  "model": ""                                         // 默认模型；留空则用请求里带的
}
```

> 改了 `config.json` 不需要重启插件，网关切页时会重新读取。

**Key 只能通过界面或 `keys.json` 添加**，不会写进任何日志、视图或响应头（响应头里只有 `k4` 这样的内部编号）。

---

## 界面

插件在 dsh-go 的输入框上方放了一条常驻状态条，点它直接进「魔搭 Key 池」面板；另外注册了三个原生面板：

| 面板 | 位置 | 内容 |
|---|---|---|
| **魔搭 Key 池** | 对话标签 / 侧栏 / 功能页 | 三个数字（可用 / 冷却 / 魔粒）、一条魔粒进度条、Key 列表（每页 10 个）、刷新额度 / 测试全部 / 全部恢复、添加入口 |
| **Key 详情** | 侧栏 / 功能页 | 点列表任意一行进来：完整令牌、站点、额度明细、状态、失败原因，以及禁用 / 停用 / 恢复 / 删除（删除需连点两次确认） |
| **魔搭模型** | 对话标签 / 侧栏 / 功能页 | 按「国际版 / 国内版 / 双站」分组的模型列表，点一下设为默认，底部可重新拉取 |

输入框上方那条状态条显示「魔搭 93/95 · 2340 魔粒」，点一下就进面板——添加 Key、刷新额度都在面板里完成。

> 0.11.0 去掉了原先输入框上方的两个悬浮按钮：插件侧控制不了 App 给悬浮按钮加的投影，看起来像「胶囊按钮带阴影」。入口合并到状态条，一次点按到位，也不再有两层悬浮元素叠在一起。

---

## 网页版与桌面版

原生面板只在 dsh-go 手机端出现。Harness Web / 桌面端没有这套面板，所以插件在宿主自带的 webServer 上开了一个**同源管理页**：

```
http://127.0.0.1:3080/modelscope-pool
```

（端口跟着你的 Harness 网页端口走，默认 3080。）

页面上能做的事和原生面板一致：看三个数字和魔粒进度、看 Key 列表、刷新额度、测试全部、全部恢复、逐条禁用 / 停用 / 恢复 / 删除、批量添加 Key、切换默认模型。中英文跟随浏览器语言，右上角可手动切换。

两道保护：

- **只认本机回环地址**。来自 `192.168.*`、`10.*` 等局域网地址的请求直接 403，令牌不会因为开了这个页面而被同网段的人看到。
- **沿用 Harness 自己的登录校验**。这个路径和 `/api/*` 一样要过宿主的 Host/Origin 校验与 cookie 凭据，所以请在你已经登录 DSH 网页的那个浏览器里打开。

桌面端内嵌的就是同一套 Web 界面，地址相同。

## 多语言

界面文案跟随系统语言，判定顺序：

1. App 传下来的 `locale`（面板视图、数据推送、按钮回调都带）；
2. 没有时用引擎进程的 `Intl.DateTimeFormat().resolvedOptions().locale`；
3. 再没有就用 `LANG` 环境变量；
4. 都没有则按中文显示。

要加一门语言，只改 `lib/i18n.js`：`S` 里每一条都是 `[中文, 英文]`，加第三列即可（`makeT` 里的 `idx` 也要跟着扩展）。

## 魔粒用量怎么算

魔搭按「魔粒」（magicubes）计费，每个 Key 的免费额度是 **250 魔粒**。面板上的魔粒进度条（网页版是顶部那条横条）就是按这个估的：

```
总魔粒 = Key 数量 × 250
剩余   = 各 Key 剩余之和（还没查到的 Key 按满额 250 计）
已用   = 总魔粒 − 剩余
```

> 这是**估算**，不是官方账单。还没刷新过额度的 Key 会被当成满额，所以「已用」只会偏小、不会虚高。要准确数字就点「刷新额度」，或直接看每行 Key 的剩余魔粒。

## HTTP 接口

全部为 OpenAI 兼容格式。

### `POST /v1/chat/completions`

```bash
curl http://127.0.0.1:8899/v1/chat/completions \
  -H "Authorization: Bearer <config.apiKey，留空可省略>" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4.1-Flash-1017","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

成功响应的头里会标注实际用了什么：

| 响应头 | 含义 |
|---|---|
| `x-pool-key` | 内部 Key 编号，如 `k4` |
| `x-pool-region` | `ai`（国际版）或 `cn`（国内版） |
| `x-pool-model` | 你请求的模型（简化名） |
| `x-pool-upstream-model` | 实际发给上游的真实 id |

### 其它接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 存活检查 |
| `GET` | `/v1/models` | 合并后的模型列表（OpenAI 格式） |
| `GET` | `/v1/pool/status` | 每个 Key 的状态、额度、冷却原因 |
| `GET` | `/v1/pool/provider` | 当前注册的供应商信息 |
| `GET` | `/v1/pool/models` | 模型目录（含两个站点的真实 id） |
| `GET` | `/v1/pool/balance` | 汇总额度 |
| `POST` | `/v1/pool/model` | 设置默认模型 |

### 错误码

网关自己产生的错误沿用 OpenAI 的结构：

```json
{ "error": { "message": "池里还没有 Key", "type": "no_keys" } }
```

| `type` | HTTP | 含义 |
|---|---|---|
| `no_keys` | 503 | 池里一个 Key 都没有 |
| `no_available_key` | 429 | Key 都在冷却/停用，等一会或加新 Key |
| `model_unavailable` | 403 | 所有 Key 都拿不到这个模型（多半没开通），带 `retry-after` |
| `upstream_unreachable` | 502 | 所有线路都连不上上游 |
| `pool_error` | 4xx/5xx | 其它网关侧错误 |

---

## 接入其它客户端

任何支持 OpenAI 接口的客户端都能用，填三样：

| 字段 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8899/v1` |
| API Key | `config.json` 里的 `apiKey`；留空随便填 |
| Model | 面板里「魔搭模型」中挑一个 |

dsh-go 里更进一步：这个插件会把自己注册成一个叫 **魔搭 Key 池** 的供应商，模型直接出现在 App 的「模型」列表里，选一次就不用再管。

---

## 模型上下文与最大输出

魔搭的 `/v1/models` 只回 `id / owned_by / created`，详情接口和模型页也没有上下文字段——官方数字只写在**模型卡片的说明里**。所以插件对能确认的旗舰模型逐个填真实值，其余不声明、走插件默认（上下文 128K）。

| 模型 | 上下文 | 最大输出 | 卡片依据 |
|---|---|---|---|
| `DeepSeek-V4-Pro` | 1,000,000 | — | 参数表 Context Length = 1M |
| `DeepSeek-V4-Pro-0813` | 1,000,000 | 393,216 | 正文「最大输出长度 384K」 |
| `DeepSeek-V4.1-Flash` | 1,000,000 | — | 正文「up to one million tokens」 |
| `DeepSeek-V4.1-Flash-1017` | 1,000,000 | 262,144 | 参数表 `context_window` 1M / `max_tokens` ≥ 256K |
| `GLM-5.2` | 1,000,000 | — | 正文「Solid 1M Context」 |

「—」表示卡片没写，就不填：DSH 没拿到最大输出时用它自己的默认，比瞎编一个安全。

> 最大输出只在**明显小于上下文**时才填。`Step-5-Preview` 卡片写的是上下文 1M、最大输出也是 1M，两边相等会让 DSH 的「预留回复额度」把整个窗口吃掉，压缩预算变成 0，切模型反而报错，所以这个型号只按默认走。

新增模型：在 `lib/specs.js` 里加一行 `简化名 → { contextWindow, maxTokens }` 即可，键不区分大小写，没列到的自动回落到插件默认。

## 常见问题

**导入后一堆 Key 显示「令牌无效」？**
先看是哪个站点。`.ai` 令牌发到 `.cn`（或反过来）一定返回 401。面板里会显示每个 Key 识别出的站点；如果识别错了，把 Key 删掉重新导入。另外别同时探测太多 Key，并发过高会让上游返回 429，被误判成无效。

**`Qwen-Ambassador/*`、`MiniMax/MiniMax-M3` 总是失败？**
这些模型需要额外开通权限，普通令牌访问会得到 403。这是正常的，网关会直接返回 `model_unavailable`，不会把 Key 一起停掉。

**额度明明还有，却一直 `429`？**
魔搭的 `429` 有两种：`insufficient balance`（真没钱）和 `Throttling`（限流）。网关靠报错文案区分。如果文案变了，改 `lib/proxy.js` 里的 `quotaLike()` 正则。

**Key 一直不自动恢复？**
看看是不是被「手动禁用」了（`manual` 标记）。手动禁用不会被自动恢复流程放开，需要点「恢复」。

**点「刷新额度」提示「魔搭 Key 池没有响应」？**
App 要求点按在 3 秒内返回，而刷新额度要联网逐个查所有 Key 的额度，早就超过 3 秒了。0.10.3 起这几个慢操作（刷新额度 / 测试全部 / 重新拉取模型 / 添加 Key）不再在点按里等：点一下立刻在**面板顶部**显示「正在刷新额度」，**3 秒后自动收起**（操作不会中断），跑完再把结果挂上去 3 秒。如果你还在 0.10.0 或更早，升级即可。

**一次粘贴很多个 Key，只加进去一部分？**
每行一个，或者用逗号、空格、分号分隔都行，重复的会自动跳过。0.11.0 起入库是本地写文件、立刻返回，认站点和查额度放到后台，粘 50 个也不会卡住，也不会挡住下一批。

**为什么模型列表里没有国内版模型？**
面板和模型页只显示「池里真有这个站点 Key」的模型。只有国际版 Key 时，国内版独占的模型不会出现；等加进国内版 Key 并查过额度后，它们会自动出现。

**端口被占用？**
改 `config.json` 的 `port`，同时把客户端和供应商配置里的地址一起改掉。

---

## 安全说明

- Key **只**保存在本机 `$DSH_HOME/modelscope-pool/keys.json`，文件权限 `0600`。
- 网络接口只监听 `127.0.0.1`，不对外暴露。
- 日志、面板视图、响应头里只有内部编号（`k4`）和掩码（`ms-…add2`），完整令牌只在你主动点开「Key 详情」时显示。
- 仓库里不含任何真实令牌；`.gitignore` 已排除所有运行时数据文件。
- 请不要把你的 `keys.json`、`.env` 或截图里的完整令牌提交到仓库或贴进 issue。

---

## 开发

```
lib/
  index.js     插件入口：面板、动作、状态条、供应商注册
  proxy.js     OpenAI 兼容网关：路由、重试、错误分类
  pool.js      Key 池：持久化、冷却、额度下限、手动禁用
  quota.js     额度查询：.ai / .cn 双站点、退避、并发控制
  catalog.js   模型目录：两站拉取、按简化名合并、跨站 id 映射
  provider.js  注册成 DSH 模型供应商（含展示名、分组）
  route.js     「Key × 模型」黑名单与线路健康度
```

约定：

- 只用 Node 内置模块，没有第三方运行时依赖。
- 所有界面文案走 `{ zh, en }`。
- 改完跑一遍语法检查和插件检查器：

```bash
node --check lib/index.js
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" . --load
```

欢迎 issue 和 PR。提交前请确认没有把令牌、`keys.json` 或日志带进来。

---

## 声明

- 本项目与**魔搭（ModelScope）官方无关**，不是官方客户端，也未获官方认可或背书。
- 只是跑在本机的一个客户端侧聚合工具：所有请求仍由你自己的 Key 直接发往魔搭官方接口，作者不经手、不中转任何流量。
- 「魔粒」额度、站点归属、模型列表都以魔搭官方返回为准；本项目里的 250 魔粒/Key 是**估算值**，仅用于界面展示，不构成任何额度承诺。
- 请自行阅读并遵守 [ModelScope 服务条款](https://modelscope.cn) 与各模型自己的许可条款。因违反条款、超额调用或令牌泄露造成的后果由使用者自负。
- 软件按 MIT 许可「按原样」提供，不附带任何明示或默示担保。

## License

[MIT](LICENSE) © 2026 Yizutt