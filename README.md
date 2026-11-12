# dsh-modelscope-pool

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

### 作为 dsh-go 原生插件安装

```bash
# 1. 把仓库放进 dsh-go 的本地插件目录
#    目录名必须叫 local-modelscope-pool（与 package.json 的 name 一致）
mkdir -p "$DSH_HOME/dsh-go/plugins"
cd "$DSH_HOME/dsh-go/plugins"
git clone https://github.com/Yizutt/dsh-modelscope-pool.git local-modelscope-pool

# 2. 装进当前 profile
dsh plugin --profile web add "$DSH_HOME/dsh-go/plugins/local-modelscope-pool"
```

装好后重启 App，或让插件重新加载。网关会在 `127.0.0.1:8899` 起来。

### 只想用网关、不装 App

插件本身就是一个 Cordis bundle（`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），所以也可以直接挂到 Harness 的 profile 里：

```bash
dsh plugin --profile web add /path/to/dsh-modelscope-pool
```

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

插件在 dsh-go 的对话界面加了入口（输入框上方两个按钮 + 一条常驻状态条），另外注册了三个原生面板：

| 面板 | 位置 | 内容 |
|---|---|---|
| **魔搭 Key 池** | 对话标签 / 侧栏 / 功能页 | 可用 / 冷却 / 魔粒三个数字、Key 状态扇形图、Key 列表（分页）、刷新额度、测试全部、全部恢复、添加 Key |
| **Key 详情** | 侧栏 / 功能页 | 点列表任意一行进来：完整令牌、站点、额度明细、状态、失败原因，以及禁用 / 停用 / 恢复 / 删除（删除需连点两次确认） |
| **魔搭模型** | 对话标签 / 侧栏 / 功能页 | 按「国际版 / 国内版 / 双站」分组的模型列表，点一下设为默认，底部可重新拉取 |

输入框上方还有一条常驻状态条，显示池里可用 Key 的数量。

---

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

## 常见问题

**导入后一堆 Key 显示「令牌无效」？**
先看是哪个站点。`.ai` 令牌发到 `.cn`（或反过来）一定返回 401。面板里会显示每个 Key 识别出的站点；如果识别错了，把 Key 删掉重新导入。另外别同时探测太多 Key，并发过高会让上游返回 429，被误判成无效。

**`Qwen-Ambassador/*`、`MiniMax/MiniMax-M3` 总是失败？**
这些模型需要额外开通权限，普通令牌访问会得到 403。这是正常的，网关会直接返回 `model_unavailable`，不会把 Key 一起停掉。

**额度明明还有，却一直 `429`？**
魔搭的 `429` 有两种：`insufficient balance`（真没钱）和 `Throttling`（限流）。网关靠报错文案区分。如果文案变了，改 `lib/proxy.js` 里的 `quotaLike()` 正则。

**Key 一直不自动恢复？**
看看是不是被「手动禁用」了（`manual` 标记）。手动禁用不会被自动恢复流程放开，需要点「恢复」。

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

## License

[MIT](LICENSE) © 2026 Yizutt

本项目与 ModelScope（魔搭）官方无关，只是本机的客户端侧聚合工具。使用前请自行阅读并遵守 [ModelScope 服务条款](https://modelscope.cn)。