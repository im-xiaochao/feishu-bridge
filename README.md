# feishu-bridge（飞书桥接）

把飞书群和管家对话接成双向通道：群里发的消息管家收得到，管家的回复也会回到群里。跑在 DSH 进程内，随 DSH 启动、随 DSH 退出，不留后台进程。

开源项目，MIT 许可，不发 npm。

> ⚠️ **隐私提示（请先读这条）**
> 装上之后，插件会把飞书群里**每一条**用户文本消息原样投递给你的 DSH 会话，作为一条普通消息进入管的上下文；管家的回复也会**原样发送回这个群**，群里所有人都能看到。
> 也就是说：群里说的话会离开飞书、进入你的本地 DSH 会话与 LLM 请求；DSH 的回答会公开发到群里。
> 请只把它接到你愿意这样做的群。敏感群、外部人员群不要用。

## 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | 已安装可运行的 DSH Desktop | 插件跑在 DSH 进程内，通过 `sessionController` 投递消息、监听 `session/event` 回传回复 |
| Node.js | ≥ 22.19（建议 24） | 用到 `AbortSignal.timeout`、`node:crypto` 的 `randomUUID`、`fetch` |
| 操作系统 | **目前仅支持 Windows** | 安装脚本 `install.ps1` 是 PowerShell，默认路径按 `%USERPROFILE%\.dsh` 处理。macOS / Linux 暂不支持，欢迎 PR |
| PowerShell | Windows PowerShell 5.1 或 pwsh 7+ | 用来跑安装脚本 |
| 飞书 | 一个飞书企业/团队，有权限创建自建应用 | 见下一节 |

## 一览：从零到跑通

1. [在飞书建自建应用](#1-在飞书建自建应用拿-app-id--app-secret)，拿到 App ID / App Secret；
2. [给应用开权限](#2-给应用开权限要开哪三个)，把机器人拉进群；
3. [拿到群 chat_id](#3-拿到群-chat_id)；
4. [安装插件](#安装)（clone + 跑 install.ps1 + 重启 DSH）；
5. [填配置](#配置)（推荐用设置页）；
6. 在群里发一条消息，看管家是否回复。

---

## 1. 在飞书建自建应用（拿 App ID / App Secret）

1. 打开 [飞书开放平台](https://open.feishu.cn/)，用你的飞书账号登录。
2. **开发者后台 → 创建企业自建应用**，填名字和图标，创建。
3. 进入应用，在 **凭证与基础信息** 页可以看到：
   - **App ID**：形如 `cli_xxxxxxxxxxxxxxxx` → 对应插件配置里的 `appId`
   - **App Secret**：形如 `xxxxx...` → 对应插件的 App Secret（**不要**贴进任何文件或仓库，用设置页填）

## 2. 给应用开权限（要开哪三个）

在 **权限管理** 页搜索并开通下面这些权限。它们和插件实际调用的接口一一对应，缺任何一个都会在运行时报错：

| 需要的权限 | 插件用它做什么 | 缺了会怎样 |
| --- | --- | --- |
| `im:message`（获取与发送单聊、群组消息） | 读群消息列表（`GET /open-apis/im/v1/messages`） | 轮询失败，日志报 `message list refused (code ...)` |
| `im:message:send_as_bot`（以应用身份发消息） | 把管家回复发回群里（`POST /open-apis/im/v1/messages`） | 收得到群消息，但回复发不出去，日志报 `send refused (code ...)` |
| `im:chat:readonly`（获取群组信息，只读） | 按 `container_id_type=chat` 定位群 | 读消息时可能被拒 |

开通权限后，**需要发布应用版本并等管理员审批生效**（企业自建应用通常要走这一步），否则权限不生效。

### 把机器人拉进群

在飞书客户端打开目标群 → **设置 → 群机器人 → 添加机器人**，选中你刚建的应用。没拉进群的话，应用读不到该群消息。

## 3. 拿到群 chat_id

插件**没有**提供「列出我的群」的入口，`chatId` 必须你自己拿到。`chat_id` 形如 `oc_` 开头的一长串。几种可行方式：

- **方式 A：从群链接里找。** 在飞书里打开该群，部分客户端/网页版的群信息或分享链接里能看到以 `oc_` 开头的标识。
- **方式 B：用飞书开放平台的 API 调试台。** 在开发者后台的 **API 调试台**，用同一个应用调 `GET /open-apis/im/v1/chats`（获取用户或机器人所在的群列表），返回里的 `chat_id` 就是。注意该接口需要 `im:chat:readonly`。
- **方式 C：接一次事件回调。** 配置事件订阅后，机器人进群会收到 `im.chat.member.bot.added_v1` 事件，事件体里带 `chat_id`。

拿到后不要写进仓库，按下一节填到本机配置或设置页里。

---

## 安装

> 以下命令在 Windows 上执行。

```powershell
git clone <本仓库地址> feishu-bridge
cd feishu-bridge
pwsh -File .\install.ps1
```

安装脚本做三件事：把源码复制到 `~/.dsh/plugins/feishu-bridge`、逐个文件比对 SHA256（不一致立即失败退出）、检查目标目录的配置是否存在。它同时会校验 `~/.dsh/profiles/desktop/node_modules/feishu-bridge`（通常是同一个目录的 junction，两边是同一份文件，脚本只校验不复制）。

### 参数

| 参数 | 作用 |
| --- | --- |
| `-WhatIf` | 只打印将要复制哪些文件及其哈希，不落盘。建议第一次先跑这个 |
| `-TargetDir <路径>` | 复制到指定目录而不是默认的 `~/.dsh/plugins/feishu-bridge`。用于临时验证 |
| `-SkipNodeModules` | 跳过 `node_modules` 链接检查 |

```powershell
# 先看会做什么，再真装
pwsh -File .\install.ps1 -WhatIf
pwsh -File .\install.ps1
```

### 装完之后：必须重启 DSH

插件跑在 DSH 进程内，**不重启仍是旧代码**。改任何源码后都是「跑 install.ps1 → 重启 DSH」。

### 首次启动会发生什么

- 重启后如果 `appId` / `chatId` 还空着，桥接**不会启动**，日志里只有一条 warn，不影响 DSH 本身。
- 一旦配置齐全、桥接启动，**第一次轮询会把当前最新消息记为基准，不回放历史**。也就是说：**启动之前**群里发过的消息不会被处理，只有启动之后的才会。
- 记录进度的游标文件在 `~/.dsh/bot/feishu-bridge-cursor.json`，内容是 `lastCreateTime` + `chatId`。

### 卸载

```powershell
# 1. 停掉 DSH
# 2. 删除插件目录
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\plugins\feishu-bridge"
# 3. 如果 node_modules 下的 feishu-bridge 是独立目录（不是 junction），一并删掉
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\feishu-bridge"
# 4. 清理 profile 里引用它的 patch 条目（如有）
#    编辑 ~/.dsh/profiles/desktop/cordis.patch.yml，删掉 id: feishu-bridge 那一段
# 5. 可选：删掉游标
Remove-Item -Force "$env:USERPROFILE\.dsh\bot\feishu-bridge-cursor.json"
```

App Secret 存在 DSH 凭据库（`~/.dsh/.credentials.yaml`）里，如果不再使用，请在 DSH 的设置里把它删掉。

---

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

> **注意**：只有 `appId` / `chatId` / `secretName` / `pollSeconds` 是 volatile（可被设置页写入）。**如果 volatile 字段全被清空、插件没有任何 volatile 字段，设置写入会被 DSH 的写门拒绝**，表现为「看起来保存成功、实际静默回滚」。所以别把它们全清空。

### 命令行方式（可选）

不想用设置页，也可以直接改本机配置文件。

**本机配置**：把 [config.example.yml](./config.example.yml) 里那段拷进 `~/.dsh/profiles/desktop/cordis.patch.yml`，把占位符换成真值。这份文件在 `~/.dsh/` 下，不进任何仓库。

**环境变量**：参考 [.env.example](./.env.example)。在**启动 DSH 的那个终端**里先设好变量再启动 DSH（PowerShell：`$env:FEISHU_BRIDGE_APP_ID="cli_xxx"`）。注意 `.env.example` 只是示例文件、插件不会读它，插件读的是**进程环境变量**。

> **仓库里那份 bundle 层（项目根目录的 `cordis.patch.yml`）只有空占位符**（`appId: ""` / `chatId: ""`），这是本仓库能公开的前提——任何真实值都不在仓库里。安装后它会复制到 `~/.dsh/plugins/feishu-bridge/cordis.patch.yml`，起初同样是空串，桥接不启动。
>
> 真实值请放在 **profile patch 层**（`~/.dsh/profiles/desktop/cordis.patch.yml`）或用上面的**设置页**填写，两者都在 `~/.dsh/` 下，不进任何仓库。
>
> ⚠️ **若你手动往 `~/.dsh/plugins/feishu-bridge/cordis.patch.yml` 里填过真值**，那是你自己的本机状态（`install.ps1` 不会覆盖它）。它会顶掉 profile 和环境变量；要让 profile 生效，得先把那份真值清成空串，或直接用设置页改。

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

**怎么写入**：用设置页的「App Secret」栏填一次并保存（推荐）；它由 DSH 凭据库接管，写进第 1 条路径，**不回显**。设置页里的「凭据名」就是 `secretName`，改它等于换一个凭据条目。

> ⚠️ **设 `FEISHU_APP_SECRET` 这个环境变量是没用的。** 插件全文只读三个环境变量：`DSH_HOME`、`FEISHU_BRIDGE_APP_ID`、`FEISHU_BRIDGE_CHAT_ID`——**它自己不读 secret 的环境变量**。官方凭据库确实有「启动环境优先」的机制，但那要求该变量由 DSH 以启动环境注入，普通地 export 一个同名变量**读不到**，插件会静默回退到第 2 条路径，看起来像「设了不生效」。

---

## 排错

日志在 DSH 的日志里，插件打的都带 `feishu-bridge:` 前缀。

| 现象 / 日志 | 原因 | 怎么办 |
| --- | --- | --- |
| 日志只有 `appId and chatId are required; the bridge stays off` | 配置为空，桥接主动关闭 | 用设置页或 profile patch 填上 appId / chatId |
| `secret FEISHU_APP_SECRET is not saved` | 两条 secret 路径都没取到 | 用设置页的 App Secret 栏填一次并保存 |
| `token request refused (code ...)` | 鉴权失败 | App ID / App Secret 不对，或应用未发布生效；飞书错误码见[开放平台文档](https://open.feishu.cn/document/) |
| `message list refused (code ...)` | 读群消息被拒 | 没开 `im:message` 权限、机器人没被拉进群、或 chat_id 不对 |
| `send refused (code ...)` | 发消息被拒 | 没开 `im:message:send_as_bot` |
| 设置页显示「本部署的设置为只读」 | 当前部署不允许写配置 | 改用 profile patch 或环境变量 |
| 设置页显示「该插件当前未加载」 | 插件没被 DSH 加载 | 检查安装是否成功、DSH 是否已重启 |
| 群里有消息但管家没反应 | 首次启动只记基准、不回放历史；或轮询间隔未到 | 启动后**再发**一条；确认 `pollSeconds` |
| 保存设置看起来成功但没生效 | volatile 字段被清空导致写门拒绝 | 至少保留一个非空 volatile 字段 |

排查顺序建议：先确认「配置非空 → secret 有值 → token 能取到 → 能读消息 → 能发消息」，这条链路每一步的失败日志都不一样，按顺序看即可。

---

## 开发

### 目录

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

### 改动链路

改源码 → 跑 `install.ps1` → 重启 DSH。**第 3 步不可省**：插件跑在 DSH 进程内，不重启仍是旧代码。

```
1. 改 index.js / lib/ / locale/    ← 这些会真正被安装
2. pwsh -File .\install.ps1
3. 重启 DSH   ← 不可省
```

`install.ps1` 会把本项目源码复制到 `~/.dsh/plugins/feishu-bridge`，再逐个文件比对 SHA256；不一致就直接报错退出，避免出现「改了这个、跑的是那个」的幽灵版本。

同步清单**共 6 个文件**：`index.js`、`package.json`、`lib/index.js`、`lib/client.js`、`locale/en.json`、`locale/zh.json`。

**`cordis.patch.yml` 不在同步清单里，改它不会生效。**

> 本项目是唯一源码源，但**只针对代码**。`~/.dsh/plugins/feishu-bridge/cordis.patch.yml` 存的是本机真实配置，不属于安装产物，脚本不会覆盖它。

> ⚠️ **改 `package.json` 时注意**：只要声明了 `exports["./client"]` / `dsh.client`，`lib/client.js` 就必须真实存在——加载器会 `readFileSync` 它，缺文件会抛错并把插件打成 FAILED。**先落盘文件，再加声明。**

### 运行要求

- DSH 主进程；插件通过 `ctx.inject(['sessionController'])` 投递消息，通过 `session/event` 回传回复。
- `pollSeconds`（默认 10）控制轮询间隔，最小 2 秒。
- 游标文件 `~/.dsh/bot/feishu-bridge-cursor.json` 记录 `lastCreateTime` + `chatId`，首次运行取最新消息为基准，不回放历史。

## License

MIT，见 [LICENSE](./LICENSE)。
