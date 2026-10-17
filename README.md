# feishu-bridge（飞书桥接）

把飞书群和管家对话接成双向通道：群里发的消息管家收得到，管家的回复也会回到群里。跑在 DSH 进程内，随 DSH 启动、随 DSH 退出，不留后台进程。

开源项目，MIT 许可，不发 npm。

## 功能一览

一张表看全，细节在下面各节。

| 能力 | 默认 | 说明 |
| --- | --- | --- |
| **群消息 → 管家** | 开 | 群里每一条纯文字都投递进 DSH，前缀 `[飞书群消息]` |
| **管家回复 → 群** | 开 | 每次回复以卡片发回群，Markdown 正常渲染；超 3500 字按行拆成多张卡片 |
| **群图片 → 管家** | 开 | 图片归档到 `picDir`，同时把图片内容本身喂给管家 |
| **私聊消息 → 管家** | 需配置 | 私聊 `chat_id` 要写进 `directChatIds`，见[私聊](#私聊一对一会话) |
| **私聊回复 → 私聊** | 跟着上一条 | 私聊来的消息只回私聊，**不会漏进群** |
| **DSH 对话 → 飞书** | 开 | 你在 DSH 主对话里打的字和管家的回复都镜像到群，手机上不会漏 |
| **群聊（开发组/健康组）→ 飞书** | 关 | Bot 之间的讨论不外泄 |

## 隐私提示

> ⚠️ **请先读这条**
>
> - 群里/私聊里**每一条**用户文本消息都会原样投递进你的 DSH 会话，进入管家的上下文，也进入 LLM 请求。
> - 管家的回复会**原样发回**原会话（群里来的回群、私聊来的回私聊）。群里说的话群里**所有人都能看到**。
> - **DSH 主对话会镜像到飞书**：你在 DSH 界面里对管家说的话、管家的回复，都会发到 `chatId` 那个群。飞书是云端服务，这些内容会存在飞书服务器上。**不要把不能外传的内容放进主对话**。
> - 不想镜像 DSH 对话就改代码里的 `sendUserMirror` 调用点（见[镜像 DSH 对话](#镜像-dsh-对话到飞书)）。
> - 私聊一律只回私聊。若 `directChatIds` 里配了别人的私聊，那个人说的话也会进你的管家会话。
>
> **长回复会在群里显示为多条消息**，不是一条被截断的消息。

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
2. [给应用开权限](#2-给应用开权限)，把机器人拉进群；
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

## 2. 给应用开权限

在 **权限管理** 页搜索并开通下面这些权限。它们和插件实际调用的接口一一对应，缺任何一个都会在运行时报错：

| 需要的权限 | 插件用它做什么 | 缺了会怎样 |
| --- | --- | --- |
| `im:message`（获取与发送单聊、群组消息） | 读群消息列表（`GET /open-apis/im/v1/messages`） | 轮询失败，日志报 `message list refused (code ...)` |
| `im:message:send_as_bot`（以应用身份发消息） | 把管家回复发回群里（`POST /open-apis/im/v1/messages`） | 收得到群消息，但回复发不出去，日志报 `send refused (code ...)` |
| `im:chat:readonly`（获取群组信息，只读） | 按 `container_id_type=chat` 定位群 | 读消息时可能被拒 |
| `im:message.p2p_msg:readonly`（获取用户发送的单聊消息） | **只想接私聊时才需要**，读私聊消息 | 私聊读不到，日志报 `direct chat ... failed` |
| `im:resource`（获取消息中的资源文件） | 下载群/私聊里的图片 | 图片存不下来，日志报 image download refused |

只接群的话前三个就够；要接私聊必须再加 `im:message.p2p_msg:readonly`。

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

安装脚本做四件事：把源码复制到 `~/.dsh/plugins/feishu-bridge`、逐个文件比对 SHA256（不一致立即失败退出）、**在目标缺少 `cordis.patch.yml` 时补一份占位符版本（已有则原样保留、绝不覆盖）**、报告配置的最终状态。它同时会校验 `~/.dsh/profiles/desktop/node_modules/feishu-bridge`（通常是同一个目录的 junction，两边是同一份文件，脚本只校验不复制）。

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

### 必须注册 bundle，否则插件不会被加载（最容易漏的一步）

**只把文件复制到 `~/.dsh/plugins/feishu-bridge` 是不够的。** DSH 只从 profile 的 `package.json` 里 `dsh.profile.bundles` 列表发现 bundle；`~/.dsh/plugins/` 这个目录 DSH 本身并不认识。**不注册的话，DSH 不会报错、插件静默不加载，群里发消息也不会有任何反应。**

两种注册方式，任选其一。

**方式 1（推荐）：用 DSH 自带 CLI 一条命令搞定**

```powershell
dsh plugin --profile desktop add "$PWD"
```

它会在 profile 目录里跑 pnpm，把本目录以 `link:` 方式加进 `dependencies`，**并自动把 `feishu-bridge` 追加进 `dsh.profile.bundles`**（前提是包声明了 `dsh.bundle`，本项目已声明）。执行前请**完全退出 DSH**——profile 的 `package.json` 会被加锁写入。

> 如果提示 `dsh` 不是可识别的命令：说明它不在 PATH 里（DSH 安装时未必会注册到 PATH）。`dsh` 是 DSH 安装目录下自带的 CLI，位置固定在**你安装 DSH 的目录**里：
> ```
> <你的 DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd
> ```
> 例如 DSH 装在 `D:\App\deepseek-herness`，就用：
> ```powershell
> & "D:\App\deepseek-herness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "$PWD"
> ```
> 请按你自己的安装位置替换。装完请确认这一步**没有报错**再继续。

**方式 2（手工）：自己改 profile 的 `package.json`**

编辑 `~/.dsh/profiles/desktop/package.json`，做两处改动：

```jsonc
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        // …已有的项…
        "feishu-bridge"          // ← ① 追加这一行
      ]
    }
  },
  "dependencies": {
    // …已有的项…
    "feishu-bridge": "link:../../plugins/feishu-bridge"   // ← ② 加这一条
  }
}
```

> 路径 `../../plugins/feishu-bridge` 是相对 profile 目录（`~/.dsh/profiles/desktop/`）算的，指向 `~/.dsh/plugins/feishu-bridge`。如果你的安装目标不同，按实际相对路径调整。

**验证注册成功**：改完后 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里应能看到 `"feishu-bridge"`。

### 装完之后：必须重启 DSH

插件跑在 DSH 进程内，**不重启仍是旧代码**。改任何源码后都是「跑 install.ps1 → 重启 DSH」。首次安装的完整顺序是：

```
1. git clone + pwsh -File .\install.ps1
2. 注册 bundle（dsh plugin … 或手工改 profile package.json）
3. 重启 DSH   ← 不可省
4. 填配置（设置页 / profile patch）
```

### 首次启动会发生什么

- 重启后如果 `appId` / `chatId` 还空着，桥接**不会启动**，日志里只有一条 warn，不影响 DSH 本身。
- 一旦配置齐全、桥接启动，**第一次轮询会把当前最新消息记为基准，不回放历史**。也就是说：**启动之前**群里发过的消息不会被处理，只有启动之后的才会。
- 记录进度的游标文件在 `~/.dsh/bot/feishu-bridge-cursor.json`，内容是 `lastCreateTime` + `chatId`。

### 卸载

```powershell
# 1. 完全退出 DSH
# 2. 解除 bundle 注册（否则 DSH 启动时会找不到这个包而报错）
dsh plugin --profile desktop remove feishu-bridge
#    若 dsh 不在 PATH，用完整路径；或手工编辑 ~/.dsh/profiles/desktop/package.json：
#    从 dependencies 删掉 "feishu-bridge"，从 dsh.profile.bundles 删掉 "feishu-bridge"
# 3. 删除插件目录
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\plugins\feishu-bridge"
# 4. 如果 node_modules 下的 feishu-bridge 是独立目录（不是 junction），一并删掉
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\feishu-bridge"
# 5. 清理 profile patch 里引用它的条目（如有）
#    编辑 ~/.dsh/profiles/desktop/cordis.patch.yml，删掉 id: feishu-bridge 那一段
# 6. 可选：删掉游标
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

> **仓库里那份 bundle 层（项目根目录的 `cordis.patch.yml`）只有空占位符**（`appId: ""` / `chatId: ""`），这是本仓库能公开的前提——任何真实值都不在仓库里。安装时若目标 `~/.dsh/plugins/feishu-bridge/cordis.patch.yml` **不存在**，脚本会把它复制过去（起初是空串，桥接不启动）；**若已存在则保留你那份，不覆盖**。
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

> ⚠️ **设 `FEISHU_APP_SECRET` 这个环境变量是没用的。** 插件全文只读四个环境变量：`DSH_HOME`、`FEISHU_BRIDGE_APP_ID`、`FEISHU_BRIDGE_CHAT_ID`、`FEISHU_BRIDGE_DIRECT_CHAT_IDS`——**它自己不读 secret 的环境变量**。官方凭据库确实有「启动环境优先」的机制，但那要求该变量由 DSH 以启动环境注入，普通地 export 一个同名变量**读不到**，插件会静默回退到第 2 条路径，看起来像「设了不生效」。

---

## 私聊（一对一会话）

群接上了 ≠ 私聊接上了，**这是两件独立的事**。私聊要单独配，因为飞书没有提供「机器人的私聊列表」接口。

### 为什么必须手填 chat_id

`GET /open-apis/im/v1/chats` 只返回机器人**所在的群**，不返回私聊会话。所以插件没法自动发现你有几个私聊，只能把 `chat_id` 写进 `directChatIds`。

### 怎么拿到私聊的 chat_id

**方式 A（推荐）：先让机器人给你发一条私聊，接口会回给你 chat_id。**

1. 手机或飞书客户端里打开和这个机器人的**私聊**，随便发一句话（比如「1」）。
2. 调一次发消息接口，响应里的 `chat_id` 就是私聊 ID：

```bash
# 把 $TOKEN 换成 tenant_access_token，$OPEN_ID 换成你的 open_id
curl -X POST 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"receive_id":"ou_xxxxxxxx","msg_type":"text","content":"{\"text\":\"hi\"}"}'
```

响应里 `data.chat_id` 形如 `oc_xxxxxxxx...`，**这就是私聊 chat_id**。

**方式 B**：在飞书开发者后台的 **API 调试台**，用同一个应用调 `POST /open-apis/im/v1/messages`（`receive_id_type=open_id`），同样能从响应里拿到 `chat_id`。

### 怎么配

**设置页**：暂时没有私聊输入框（只有 `appId` / `chatId` / `picDir` / `pollSeconds` / `secretName` 有）。私聊要用下面的方式配。

**本机配置**（`~/.dsh/plugins/feishu-bridge/cordis.patch.yml` 或 profile patch 层）：

```yaml
config:
  appId: cli_xxxxxxxxxxxxxxxx
  chatId: oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  directChatIds:
    - oc_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
    - oc_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz   # 想接几个私聊就列几个
```

**环境变量**（项目外，不进仓库）：

```powershell
$env:FEISHU_BRIDGE_DIRECT_CHAT_IDS="oc_yyyyyyyy,oc_zzzzzzzz"   # 逗号分隔
```

### 需要的权限

私聊要比群多开一项 `im:message.p2p_msg:readonly`（获取用户发送的单聊消息）。发消息复用 `im:message:send_as_bot`，下载图片复用 `im:resource`。

### 回复去哪

**私聊来的消息只回私聊，绝不进群。** 这是硬隔离：插件记录每条消息来自哪个会话，回复时送回原会话。群里来的回群，私聊来的回私聊。

### 每个会话各记各的游标

群和每个私聊各有一条游标，存在 `~/.dsh/bot/feishu-bridge-cursor.json`：

```json
{
  "lastCreateTime": 1792215597188,
  "chatId": "oc_...",
  "direct": { "oc_...": 1792216230469 }
}
```

一个会话里的坏图片不会卡住另一个会话的消息。

---

## 镜像 DSH 对话到飞书

**这是默认开启的。** 你在 DSH 界面里对管家说的话、管家的回复，都会发到 `chatId` 那个群。目的是手机远程时不会漏掉桌面上的对话。

效果长这样：

```
飞书群里你会看到：
┌──────────────────────────┐
│ 我在 DSH 里说            │   ← 灰色标题，表示这是你在桌面打的字
│ 帮我查这周开销            │
└──────────────────────────┘
┌──────────────────────────┐
│ 这周 1280，餐饮 620 占一半 │   ← 管家的回复，无标题
└──────────────────────────┘
```

**不会镜像的**：

- 飞书消息本身（否则会无限回环）
- DSH 自己注入的时钟消息
- 开发组 / 健康组等**群聊**里的对话——Bot 之间的讨论不外泄

**怎么关掉**

在 `index.js` 的 `onSessionEvent` 里，删掉 `user/message` 分支中这两行：

```js
feishuPending = true                                       // 让回复也发飞书
void sendUserMirror(typed).catch(...)                      // 镜像用户说的话
```

只删第一行 = 桌面说的话不镜像，但管家的回复仍发群；两行都删 = 完全恢复成「只转发飞书触发的回合」。

**隐私权衡**：开了这条，DSH 主对话的全部内容都会经飞书云端。别在 DSH 里说不能外传的话，或者先关掉它。

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
| **私聊发消息，管家没反应** | `directChatIds` 没配，或配的 chat_id 不对 | 见[私聊](#私聊一对一会话)，确认列表里有那个 `oc_` |
| **私聊的回复跑到群里去了** | 不该发生，是 bug | 报 issue，附上 `replyTo` 相关日志 |
| `direct chat list failed` / `direct chat oc_... failed` | 某个私聊读失败 | 不影响群；检查该私聊 chat_id 和 `im:message.p2p_msg:readonly` 权限 |
| 群里出现「我在 DSH 里说」的卡片 | DSH 对话镜像（默认开着） | 正常行为；不想看就按[镜像 DSH 对话](#镜像-dsh-对话到飞书)关掉 |
| 飞书消息在群里出现两次 | 镜像和回传撞了，或 cursor 重置 | 检查 `feishu-bridge-cursor.json` 是否被删过 |

排查顺序建议：先确认「配置非空 → secret 有值 → token 能取到 → 能读消息 → 能发消息」，这条链路每一步的失败日志都不一样，按顺序看即可。私聊不通时，单独确认「`directChatIds` 非空 → 该 chat_id 能读到消息」。还要注意：**改了 `index.js` 必须重启 DSH**，插件是进程内加载的，不重启跑的还是旧代码。

---

## 开发

### 目录

```
feishu-bridge/
├── index.js              # 宿主半侧：桥接本体（轮询、收发、Config）
├── lib/
│   ├── index.js          # 客户端包的宿主半侧，空 apply，只为在 Loader 里占一行
│   └── client.js         # 浏览器半侧：设置页（设置 → 内置插件 → 飞书桥接）
├── cordis.patch.yml      # bundle 挂载层：仓库里只有占位符；安装时目标缺失才补一份，已有则保留
├── locale/               # 中英文标题与描述
├── install.ps1           # 复制安装到 ~/.dsh/plugins + 哈希校验（缺失时补 cordis.patch.yml）
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

同步清单**共 6 个代码文件**：`index.js`、`package.json`、`lib/index.js`、`lib/client.js`、`locale/en.json`、`locale/zh.json`。这 6 个每次安装都从源码**复制并覆盖**。

**`cordis.patch.yml` 是另一个口径**：它是 DSH 加载器必需的挂载文件，但目标位置那份同时是本机真实 `appId` / `chatId` 的载体。所以安装脚本**只在目标缺失时**从仓库复制一份占位符版本，**已有则原样保留、绝不覆盖**。改仓库里那份不会影响你本机已填的真值。

> 本项目是唯一源码源，但**只针对代码**。`~/.dsh/plugins/feishu-bridge/cordis.patch.yml` 属于安装产物（目标缺失时由脚本生成），但一旦它存在，就是本机配置、脚本不会再动它。

> ⚠️ **改 `package.json` 时注意**：只要声明了 `exports["./client"]` / `dsh.client`，`lib/client.js` 就必须真实存在——加载器会 `readFileSync` 它，缺文件会抛错并把插件打成 FAILED。**先落盘文件，再加声明。**

### 运行要求

- DSH 主进程；插件通过 `ctx.inject(['sessionController'])` 投递消息，通过 `session/event` 回传回复。
- `pollSeconds`（默认 10）控制轮询间隔，最小 2 秒。
- 游标文件 `~/.dsh/bot/feishu-bridge-cursor.json` 记录 `lastCreateTime` + `chatId`，首次运行取最新消息为基准，不回放历史。

### 回复怎么发到群里

- **以交互式卡片发送，Markdown 正常渲染**：加粗、列表、链接、代码、表格都会按格式显示，不会出现字面的星号或竖线。回复因此不会像纯文本消息那样把 Markdown 原样暴露出来。
- **长回复拆成多条卡片，内容不丢**：单条上限 3500 字符。超过时**按行分段**成多张卡片依次发送，不会截断、也不会丢内容。所以群里看到多条消息是正常现象。
- **唯一的硬切情况**：某一行本身就超过 3500 字符（例如一整段没有换行的超长文本），这一行会被硬切分到多张卡片——这是没办法按行分段时的兜底，除此之外不会在句子中间切断。

## License

MIT，见 [LICENSE](./LICENSE)。
