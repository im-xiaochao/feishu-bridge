# feishu-bridge 字段清单（前后端唯一依据）

本文件是 feishu-bridge 的唯一字段契约。任何一方要改字段名或类型，必须先改本文件并在群里同步，另一方确认后才能动代码。
依据来源：现役插件 `~/.dsh/plugins/feishu-bridge/index.js`（2026-10-13 核对）。

## 1. 插件 config 项

挂载点在 `cordis.patch.yml` 的 `config` 下。

| 字段 | 类型 | 默认值 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `appId` | string | `''` | 是 | 飞书自建应用 App ID，空则桥接不启动（日志 warn，不报错） |
| `chatId` | string | `''` | 是 | 飞书群 `chat_id`（`oc_` 开头），空则桥接不启动 |
| `secretName` | string | `'FEISHU_APP_SECRET'` | 否 | 在密钥库里查找条目的 **`name`**，不是环境变量名；可配，代码不写死 secret 值 |
| `secretsPath` | string | `~/.dsh/bot/secrets.json` | 否 | 密钥库文件绝对路径，`secretName` 在此文件的 `secrets[].name` 中查找 |
| `cursorPath` | string | `~/.dsh/bot/feishu-bridge-cursor.json` | 否 | 游标文件绝对路径 |
| `pollSeconds` | number | `10` | 否 | 轮询间隔秒数，实际取 `max(2, 值 || 10)` |

校验规则：`appId` 与 `chatId` 必须是非空 string，否则整个桥接关闭。

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

源码 `index.js:141-145`：

```js
async function secret() {
  const store = await readJson(options.secretsPath, null)
  const entry = store?.secrets?.find?.(item => item?.name === options.secretName)
  return typeof entry?.value === 'string' && entry.value !== '' ? entry.value : undefined
}
```

- 读取路径：`options.secretsPath`，默认 `~/.dsh/bot/secrets.json`。
- 查找方式：在该文件的 `secrets` 数组里按 `item.name === options.secretName` 匹配，取 `item.value`。
- 取不到时抛错：`secret ${secretName} is not saved`。
- **全程没有读环境变量**，源码里唯一的 `process.env` 用法是 `index.js:16` 的 `DSH_HOME`（决定 `HOME` 基准）。
- 约束：secret 值不进代码、不进日志、不进群聊。

## 4. 包入口

- `main` / `exports["."]` 均为 `./index.js`（**源码放项目根，不用 `src/`**）。
- `files`：`index.js`、`cordis.patch.yml`、`locale/*.json`。
- `dsh.bundle.patch`：`./cordis.patch.yml`。
