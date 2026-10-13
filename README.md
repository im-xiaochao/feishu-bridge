# feishu-bridge（飞书桥接）

把飞书群和管家对话接成双向通道：群里发的消息管家收得到，管家的回复也会回到群里。跑在 DSH 进程内，随 DSH 启动、随 DSH 退出，不留后台进程。

私有工程，不发 npm。

## 目录

```
feishu-bridge/
├── index.js              # 插件本体（唯一源码）
├── cordis.patch.yml      # bundle 挂载层：只有占位符，且不在同步清单里
├── locale/               # 中英文标题与描述
├── install.ps1           # 复制安装到 ~/.dsh/plugins + 哈希校验
├── FIELDS.md             # config 与游标字段清单（前后端唯一依据）
├── config.example.yml    # 本地配置示例（profile patch 层写法，值全是占位符）
├── .env.example          # 环境变量示例（值全是占位符）
└── package.json
```

## 改动链路

改源码 → 跑 `install.ps1` → 重启 DSH。**第 3 步不可省**：插件跑在 DSH 进程内，不重启仍是旧代码。

```
1. 改 index.js / locale/          ← 只有这些会真正被安装
2. powershell -ExecutionPolicy Bypass -File .\install.ps1
3. 重启 DSH   ← 不可省
```

`install.ps1` 会把本项目源码复制到 `~/.dsh/plugins/feishu-bridge`，再逐个文件比对 SHA256；不一致就直接报错退出，避免出现「改了这个、跑的是那个」的幽灵版本。

同步清单**只有 4 个文件**：`index.js`、`package.json`、`locale/en.json`、`locale/zh.json`（`install.ps1:27-32`）。

**`cordis.patch.yml` 不在同步清单里，改它不会生效。**

> 本项目是唯一源码源，但**只针对代码**。`~/.dsh/plugins/feishu-bridge/cordis.patch.yml` 存的是本机真实配置，不属于安装产物，脚本不会覆盖它。

## 配置

### 哪些值必须自己填

| 值 | 填哪儿 | 进 git 吗 |
| --- | --- | --- |
| `appId`（飞书 App ID） | `~/.dsh/` 下的本地配置，或环境变量 | **不进** |
| `chatId`（飞书群 ID） | 同上 | **不进** |
| App Secret | `~/.dsh/bot/secrets.json`，按 `secretName` 查 | **不进** |
| `pollSeconds` | 可选，项目里的 `cordis.patch.yml` 写默认值即可 | 进，非敏感 |

### 取值优先级

```
本地配置（profile patch 层 / 现役 cordis.patch.yml）  >  环境变量  >  占位符（空）
```

即：**config 里已经给了非空 `appId` / `chatId` 时，环境变量不参与**；只有 config 为空或缺失，才回退 `FEISHU_BRIDGE_APP_ID` / `FEISHU_BRIDGE_CHAT_ID`。依据：`index.js:78-83`。

两边都空则桥接不启动，只打一条 warn，不影响 DSH 启动。

### 怎么填

> ⚠️ **当前状态下，方式一填了也不生效。** 现役 `~/.dsh/plugins/feishu-bridge/cordis.patch.yml` 的 bundle 层里**已经写死了真实 appId / chatId**，它先给出非空值，环境变量和 profile 都被顶掉。要让方式一生效，必须先把现役那份 bundle 配置里的真值清成空串（这是本机文件、不进 git），或者等这套链路整体切换时再迁。**别在没做这步之前以为填 profile 就好了。**

**方式一：本机配置（推荐，稳定持久）**

把 [config.example.yml](./config.example.yml) 里那段拷进 `~/.dsh/profiles/desktop/cordis.patch.yml`，把两个占位符换成真值。这份文件在 `~/.dsh/` 下，不进任何仓库。

**方式二：环境变量（临时、一次性）**

参考 [.env.example](./.env.example)，在启动 DSH 的终端里先设好再起进程。**同样受上面那条限制**：现役 bundle 层有真值时，环境变量不参与。

> **坑**：环境变量只看「是否非空」，不校验格式。一旦它真的参与，填了 `cli_your_app_id_here` 这类**看起来像占位符、实际非空**的值，会被当成真值拿去鉴权然后失败，而且**不会**打「未配置」的 warn。要么填真值，要么就把变量留空不设。

> `.env` 本身已被 `.gitignore` 挡住，`.env.example` 是占位符版本，可以进仓库。

### App Secret

App Secret 不进代码、不进仓库。插件按 `secretName`（默认 `FEISHU_APP_SECRET`）**依次**从两处取，先取到先用：

1. **DSH 官方凭据库**（`ctx.credentials.resolve`）——存放在 `~/.dsh/.credentials.yaml`
2. **兼容回退**：`~/.dsh/bot/secrets.json` 里 `name` 等于 `secretName` 的那条

第 2 条是为了不要求老用户重填密钥而保留的兼容路径，新装用户走第 1 条即可。

> ⚠️ **设 `FEISHU_APP_SECRET` 这个环境变量是没用的。** 插件全文只读三个环境变量：`DSH_HOME`、`FEISHU_BRIDGE_APP_ID`、`FEISHU_BRIDGE_CHAT_ID`——**它自己不读 secret 的环境变量**。官方凭据库确实有「启动环境优先」的机制，但那要求该变量由 DSH 以启动环境注入，普通地 export 一个同名变量**读不到**，插件会静默回退到第 2 条路径，看起来像「设了不生效」。

## 运行要求

- DSH 主进程；插件通过 `ctx.inject(['sessionController'])` 投递消息，通过 `session/event` 回传回复。
- `pollSeconds`（默认 10）控制轮询间隔，最小 2 秒。
- 游标文件 `~/.dsh/bot/feishu-bridge-cursor.json` 记录 `lastCreateTime` + `chatId`，首次运行取最新消息为基准，不回放历史。
