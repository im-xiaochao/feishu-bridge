# feishu-bridge 字段清单（前后端唯一依据）

本文件是 feishu-bridge 的唯一字段契约。任何一方要改字段名或类型，必须先改本文件并在群里同步，另一方确认后才能动代码。
依据来源：现役插件 `~/.dsh/plugins/feishu-bridge/index.js`（2026-10-13 核对）。

## 1. 插件 config 项

挂载点在 `cordis.patch.yml` 的 `config` 下。

| 字段 | 类型 | 默认值 | 必填 | volatile | 说明 |
| --- | --- | --- | --- | --- | --- |
| `appId` | string | `''` | 是 | **是** | 飞书自建应用 App ID，空则桥接不启动（日志 warn，不报错）；可在设置页编辑 |
| `chatId` | string | `''` | 是 | **是** | 飞书群 `chat_id`（`oc_` 开头），空则桥接不启动；可在设置页编辑 |
| `secretName` | string | `'FEISHU_APP_SECRET'` | 否 | **是** | **存放 App Secret 的凭据条目名**（DSH 凭据库里的 ref 名），不是环境变量名、也不是文件名；可在设置页编辑 |
| `pollSeconds` | number | `10` | 否 | **是** | 轮询间隔秒数，实际取 `max(2, 值 \|\| 10)`；可在设置页编辑 |
| `botStatePath` | string | `~/.dsh/bot/state.json` | 否 | 否 | 管家状态文件路径 |
| `cursorPath` | string | `~/.dsh/bot/feishu-bridge-cursor.json` | 否 | 否 | 游标文件绝对路径 |
| `batchMax` | number | `10` | 否 | 否 | 单轮最多处理的消息条数 |
| `prefix` | string | `'[飞书群消息]'` | 否 | 否 | 投递给管家的消息前缀，也用于识别「这轮是飞书来的」 |

校验规则：`appId` 与 `chatId` 必须是非空 string，否则整个桥接关闭。

> **`secretsPath` 已移除**（2026-10-13 第 3 步）。老的 `~/.dsh/bot/secrets.json` 位置改由模块常量 `LEGACY_SECRETS_PATH` 承载，只用于兼容回退读取，不再是一个配置项。

> **volatile 说明**：**只有标了 volatile 的字段才会出现在设置表单里，也只有它们能被设置页写回**（官方 `volatileForm` / `isVolatilePath`：非 volatile 的路径既进不了表单、也过不了写入检查）。所以：
> - 页面上**每一个可编辑字段都必须是 volatile**，否则用户填了会被静默丢弃——这正是「看起来保存、实际回滚」的根源。
> - 反过来说，一个插件若**没有任何 volatile 字段**，设置写入会被写门直接拒绝（报 `has no volatile fields`）。
> - `botStatePath` / `cursorPath` / `batchMax` / `prefix` 是宿主内部路径与行为参数，**故意不标 volatile**，不给用户在页面上改。

## 2. 游标文件

- 文件：`feishu-bridge-cursor.json`（默认落在 `~/.dsh/bot/`）
- 写入字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `lastCreateTime` | number | 已处理到的最新消息 `create_time`（毫秒） |
| `chatId` | string | 写入时所在群的 chatId，用于识别游标归属 |

- 读回时只取 `lastCreateTime`，且必须是 number，否则视为无游标（`null`），走首次初始化。
- 注意：写入有 **两个** 字段，不是只有 `lastCreateTime`。

## 3. Secret 来源（**不是环境变量**）

取 secret 有**两条路径，先取到先用**：

```js
async function secret() {
  const fromSeam = await secretFromCredentials()   // 1) DSH 官方凭据库
  if (fromSeam !== undefined) return fromSeam
  return secretFromLegacyStore()                    // 2) 兼容回退
}
```

**路径 1 —— 官方凭据 seam**（`secretFromCredentials()`）

- 调 `ctx.credentials.resolve(secretName)`，键名由 `secretName` 指定。
- `credentialRef()` 只是「按 `/^[A-Za-z_][A-Za-z0-9_]*$/` 校验 + 原样返回」，所以代码内联了同样的正则校验，没有为一个纯校验多引一个包。
- `secretName` 不符合该正则时不硬转，打一条 warn 后交给回退路径。
- 该服务的查找优先级由 provider 决定：**启动环境 > 存储文件 > `.env` 兜底**。

**路径 2 —— 兼容回退**（`secretFromLegacyStore()`）

- 读 `LEGACY_SECRETS_PATH`（`~/.dsh/bot/secrets.json`），在 `secrets` 数组里按 `item.name === secretName` 匹配，取 `item.value`。
- 保留它是为了不让老用户重填密钥；新装用户走路径 1 即可。

**两条路径都取不到时**抛错：`secret ${secretName} is not saved`。

**约束**：secret 值不进代码、不进日志、不进群聊。

> ⚠️ **设 `FEISHU_APP_SECRET` 这个环境变量没用。** 插件全文只读三个环境变量：`DSH_HOME`、`FEISHU_BRIDGE_APP_ID`、`FEISHU_BRIDGE_CHAT_ID`。路径 1 的「启动环境优先」要求该变量由 DSH 以启动环境注入；普通地 export 一个同名变量读不到，插件会静默回退到路径 2。

## 4. 包入口

- `main` / `exports["."]` 均为 `./index.js`（**宿主源码放项目根，不用 `src/`**）。
- `exports["./client"]` → `./lib/client.js`（**浏览器半侧：设置页**）。
- `lib/index.js` 是客户端包的宿主半侧，只有空 `apply()`，作用是在 Loader 里占一行。
- `files`：`index.js`、`lib`、`cordis.patch.yml`、`locale/*.json`。
- `dsh.bundle.patch`：`./cordis.patch.yml`。
- `dsh.client.inject`：`dsh-client-ui-settings`、`dsh-client-ui-settings-plugins`、`dsh-client-ui-primitives`、`dsh-client-locale`；`platform: web`。

> ⚠️ **声明了 `exports["./client"]` / `dsh.client`，文件就必须真实存在。** DSH 加载器在激活阶段会 `readFileSync(clientPath)`，文件缺失抛 `MissingClientBundleError`，聚合成 `ClientPackageCompositionError` 后**直接 throw、把 fiber 打成 FAILED**（不是静默忽略）。2026-10-13 踩过一次：先加声明、后建文件，被 QA 和后端翻加载器源码拦下。**先落盘文件，再加声明。**
