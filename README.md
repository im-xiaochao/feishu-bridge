# feishu-bridge（飞书桥接）

把飞书群和管家对话接成双向通道：群里发的消息管家收得到，管家的回复也会回到群里。跑在 DSH 进程内，随 DSH 启动、随 DSH 退出，不留后台进程。

私有工程，不发 npm。

## 目录

```
feishu-bridge/
├── index.js              # 宿主半侧：桥接本体（轮询、收发、Config）
├── lib/
│   ├── index.js          # 客户端包的宿主半侧，空 apply，只为在 Loader 里占一行
│   └── client.js         # 浏览器半侧：设置页（设置 → 内置插件 → 飞书桥接）
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
1. 改 index.js / lib/ / locale/    ← 这些会真正被安装
2. powershell -ExecutionPolicy Bypass -File .\install.ps1
3. 重启 DSH   ← 不可省
```

`install.ps1` 会把本项目源码复制到 `~/.dsh/plugins/feishu-bridge`，再逐个文件比对 SHA256；不一致就直接报错退出，避免出现「改了这个、跑的是那个」的幽灵版本。

同步清单**共 6 个文件**：`index.js`、`package.json`、`lib/index.js`、`lib/client.js`、`locale/en.json`、`locale/zh.json`。

**`cordis.patch.yml` 不在同步清单里，改它不会生效。**

> 本项目是唯一源码源，但**只针对代码**。`~/.dsh/plugins/feishu-bridge/cordis.patch.yml` 存的是本机真实配置，不属于安装产物，脚本不会覆盖它。

> ⚠️ **改 `package.json` 时注意**：只要声明了 `exports["./client"]` / `dsh.client`，`lib/client.js` 就必须真实存在——加载器会 `readFileSync` 它，缺文件会抛错并把插件打成 FAILED。**先落盘文件，再加声明。**

## 配置

### 推荐方式：设置页（图形界面）

DSH 启动后，打开 **设置 → 内置插件 → 飞书桥接**，在页面里填：

| 页面上的项 | 说明 |
| --- | --- |
| **App ID** | 飞书自建应用的 App ID，`cli_` 开头 |
| **群 chat_id** | 飞书群的 chat_id，`oc_` 开头 |
| **轮询间隔** | 秒，小于 2 会被抬到 2 |
| **凭据名** | 存 App Secret 的凭据条目名，默认 `FEISHU_APP_SECRET` |
| **App Secret** | **不回显**，只显示「已配置 / 未配置」；留空表示保持当前值 |

页面顶部有一条状态：App ID 和 chat_id 都非空时显示「已配置，桥接将启动」，否则显示未配置。

点**保存**才写入。保存落在 profile 的本机配置里，**不进仓库、不上传**。App Secret 走 DSH 凭据库写入，同样不进仓库。

> **注意**：只有 `appId` / `chatId` / `secretName` 三个字段是 volatile（可被设置页写入）。**如果这三个字段都被清空、插件没有任何 volatile 字段，设置写入会被 DSH 的写门拒绝**，表现为「看起来保存成功、实际静默回滚」。所以别把三个都清空。

### 命令行方式（可选）

不想用设置页，也可以直接改本机配置文件。

**本机配置**：把 [config.example.yml](./config.example.yml) 里那段拷进 `~/.dsh/profiles/desktop/cordis.patch.yml`，把占位符换成真值。这份文件在 `~/.dsh/` 下，不进任何仓库。

**环境变量**：参考 [.env.example](./.env.example)，在启动 DSH 的终端里先设好再起进程。

> ⚠️ **现役 bundle 层里已写死真实 appId / chatId**（`~/.dsh/plugins/feishu-bridge/cordis.patch.yml`，本机文件、不进 git）。它有值时会顶掉 profile 和环境变量。要让 profile 生效，得先把那份真值清成空串，或直接用上面的设置页改。

### 取值优先级

```
config（设置页 / profile patch / 现役 cordis.patch.yml）  >  环境变量  >  占位符（空）
```

即：**config 里已经给了非空 `appId` / `chatId` 时，环境变量不参与**；只有 config 为空或缺失，才回退 `FEISHU_BRIDGE_APP_ID` / `FEISHU_BRIDGE_CHAT_ID`。

两边都空则桥接不启动，只打一条 warn，不影响 DSH 启动。

> **坑**：环境变量只看「是否非空」，不校验格式。一旦它真的参与，填了 `cli_your_app_id_here` 这类**看起来像占位符、实际非空**的值，会被当成真值拿去鉴权然后失败，而且**不会**打「未配置」的 warn。要么填真值，要么就把变量留空不设。

> `.env` 本身已被 `.gitignore` 挡住，`.env.example` 是占位符版本，可以进仓库。

### App Secret

App Secret 不进代码、不进仓库。插件按 `secretName`（默认 `FEISHU_APP_SECRET`）**依次**从两处取，先取到先用：

1. **DSH 官方凭据库**（`ctx.credentials.resolve`）——存放在 `~/.dsh/.credentials.yaml`
2. **兼容回退**：`~/.dsh/bot/secrets.json` 里 `name` 等于 `secretName` 的那条

第 2 条是为了不要求老用户重填密钥而保留的兼容路径，新装用户走第 1 条即可。

设置页里的「凭据名」就是 `secretName`，改它等于换一个凭据条目；「App Secret」栏填的值由 DSH 凭据库接管（写进第 1 条），**不回显**。

> ⚠️ **设 `FEISHU_APP_SECRET` 这个环境变量是没用的。** 插件全文只读三个环境变量：`DSH_HOME`、`FEISHU_BRIDGE_APP_ID`、`FEISHU_BRIDGE_CHAT_ID`——**它自己不读 secret 的环境变量**。官方凭据库确实有「启动环境优先」的机制，但那要求该变量由 DSH 以启动环境注入，普通地 export 一个同名变量**读不到**，插件会静默回退到第 2 条路径，看起来像「设了不生效」。

## 运行要求

- DSH 主进程；插件通过 `ctx.inject(['sessionController'])` 投递消息，通过 `session/event` 回传回复。
- `pollSeconds`（默认 10）控制轮询间隔，最小 2 秒。
- 游标文件 `~/.dsh/bot/feishu-bridge-cursor.json` 记录 `lastCreateTime` + `chatId`，首次运行取最新消息为基准，不回放历史。
