# dsh-plugin-mail-notify · 邮件通知与续聊

DeepSeek Harness 插件：**轮次结束时发一封摘要邮件**；在严格校验之后，**允许你回复邮件继续原会话**。

它是本工作区里 Codex 邮件通知插件（`src/codex_notify`，Python）的 Harness 原生移植版：同一套通知队列、同一套验证码与回复校验、同样拒绝用邮件批准任何权限。区别在于它不再轮询 Codex 的线程历史，而是直接挂在 Harness 自己的会话事件流上。

---

## 目录

- [它能做什么](#它能做什么)
- [安装](#安装)
- [配置](#配置)
- [日常使用](#日常使用)
- [安全模型](#安全模型)
- [与 Codex 版本的对照](#与-codex-版本的对照)
- [开发与测试](#开发与测试)
- [卸载](#卸载)
- [已知限制](#已知限制)

---

## 它能做什么

- **轮次结束通知**：一个轮次以 `completed` 结束、或以 `error` / `blocked` / `max-tokens` 结束时发信。`aborted`（你按了停止）、`interrupted`（被上级取消）、`forked` 不发信——它们不是你需要被邮件打扰的结果。
- **等待状态通知**（可选）：`approval/asked` 时通知「等待权限审批」；`ask_user_question` 工具被调用时通知「等待你回答」，并把问题与选项原文写进邮件正文。
- **摘要而非全文**：邮件包含状态、标题、本地任务编号、会话标识摘要、开始/结束时间、耗时、回复摘要（可截断）、错误摘要、回复验证码、回复说明。**不包含**完整模型输出。
- **持久通知队列**：JSON 落盘、指数退避（`2^n` 秒，上限 300 秒）、最多 5 次自动重试、手动重试、重启恢复、`sending` 状态崩溃恢复、按通知编号幂等。
- **严格回复校验**：白名单发件人、任务编号、回复验证码（24 小时有效、**期内可多次回复**）、Message-ID 去重、拒绝附件、正文长度上限、剥离引用历史与签名。任何一条不过就拒收，且**不会**把你的邮件标为已读。
- **回复路由**：校验通过的正文通过 `agent.followup()` 交回原会话——空闲时开启新轮次，运行中则由 Harness 自己的收件箱排队。
- **权限审批永不通过邮件**：插件只记录与通知，从不代替你批准任何东西。
- **安全**：授权码只经 Harness 凭据服务（`ctx.credentials`）保存，配置文件里没有它；审计日志对疑似机密做脱敏；全局暂停续聊；回复频率限制。

## 安装

需要 Node.js ≥ 20（Harness 自带运行时即可）与 Windows / macOS / Linux 上的 Harness。

```powershell
# 1) 安装（写入 profile 依赖与插件行，并调用 Harness 自带的 pnpm 建立链接）
node D:\Ai\codex通知插件\dsh-plugin-mail-notify\scripts\configure.mjs --no-config

# 2) 检查
node D:\Ai\codex通知插件\dsh-plugin-mail-notify\scripts\verify-install.mjs

# 3) 完全退出并重新启动 DeepSeek Harness
```

第 1 步会在改动前把 profile 的 `package.json`、`cordis.patch.yml` 以及凭据文件复制到
`<profile>\.mail-notify-backup-<时间戳>\`。它**不会**重启你的 Harness。

安装后插件处于「未配置」状态：会正常加载、注册监听、报告 `configured: false` 并保持空闲——不会因为缺配置而让整个 profile 加载失败。

## 配置

```powershell
# 交互式输入授权码（不回显进摘要；建议用管道传入）
node scripts\configure.mjs --sender 你的邮箱@qq.com

# 非交互：从 stdin 读授权码
Get-Content .\code.txt | node scripts\configure.mjs --sender 你的邮箱@qq.com --auth-code-stdin

# 只写配置、不碰凭据文件
node scripts\configure.mjs --sender 你的邮箱@qq.com --no-credential

# 先看会发生什么（不写任何文件）
node scripts\configure.mjs --sender 你的邮箱@qq.com --auth-code x --dry-run
```

`--recipient` 默认等于 `--sender`，`--reply-to` 默认也等于 `--sender`（即单邮箱自收自发，这也是原始插件的常见用法）。

SMTP / IMAP 的默认值就是 QQ 邮箱的正确值（`smtp.qq.com:465/ssl`、`imap.qq.com:993/ssl`），企业邮箱用 `--smtp-host` / `--imap-host` 等覆盖：

| 参数 | 说明 |
|---|---|
| `--smtp-host` `--smtp-port` `--smtp-security` | `ssl`（隐式 TLS）或 `starttls` |
| `--imap-host` `--imap-port` `--imap-security` | 同上 |
| `--prefix` | 主题标签，默认 `[DSH]`；同时是 IMAP 搜索条件，别乱改 |
| `--data-dir` | 插件数据目录，默认 `<DSH_HOME>/mail-notify` |
| `--profile` `--home` `--credentials` | 路径覆盖 |

**授权码存到哪里**：Harness 凭据服务，引用名 `DSH_MAIL_NOTIFY_AUTH_CODE`，落在
`<DSH_HOME>/.credentials.yaml` 的 `refs:` 分节。插件按操作读取它，所以在 Harness 里轮换该值会在下一次请求生效，不需要重启。你也可以改用在 Harness 设置界面里保存同名密钥。

> 该文件同时保存 Harness 的其他凭据。`configure.mjs` **从不打印它的内容**（连掩码后的整份文件也不打印），只描述将要做的那一处改动。

## 日常使用

插件随 Harness 进程运行，没有独立的后台服务、托盘图标或开机自启项——进程生命期由 Harness 自己拥有。

状态与队列可以直接读插件的数据目录：

```powershell
# 通知队列
Get-Content "$env:USERPROFILE\.dsh\mail-notify\notifications.json"

# 审计日志（已脱敏，不含授权码与验证码）
Get-Content "$env:USERPROFILE\.dsh\mail-notify\audit.json" -Tail 20

# 回复验证码与任务映射
Get-Content "$env:USERPROFILE\.dsh\mail-notify\tokens.json"
Get-Content "$env:USERPROFILE\.dsh\mail-notify\state.json"
```

暂停 / 恢复续聊：把 `continuationEnabled` 设为 `false` 后重启 Harness（配置改动在启动时读取）。
暂停期间收到的回复仍然保留在内存队列里，不会丢。

## 安全模型

| 关注点 | 做法 |
|---|---|
| 授权码 | 只经 `ctx.credentials` 保存；配置、日志、审计、`--json` 输出里都没有它 |
| 邮件正文 | 只发摘要，不发完整模型输出 |
| 谁能触发续聊 | 仅白名单地址 + 任务编号 + 回复验证码三者同时正确 |
| 验证码 | 24 小时有效、期内可重复使用、常量时间比较 |
| 权限审批 | **永不**通过邮件批准；等待审批期间的回复会被排队 |
| 频率 | 每分钟最多 20 条回复（可配 `maxRepliesPerMinute`） |
| 附件 | 一律拒收 |
| 审计 | 写入前脱敏（授权码、验证码、8 位大写十六进制令牌） |
| 拒收的邮件 | 不标为已读，留在你的邮箱里；本地记住 Message-ID 以免重复处理 |

## 与 Codex 版本的对照

功能逐项对齐，实现方式按 Harness 的接口重写：

| 能力 | Codex 版 | 本插件 |
|---|---|---|
| 发现已完成任务 | 定时轮询 `thread/list` + `thread/read` | 订阅 `ctx.on('session/event')` 的 `turn/end`（无轮询延迟） |
| 结束原因映射 | `completed` / `failed` | `completed` / `error` / `blocked` / `max-tokens` |
| 通知队列 | Python JSON 队列 | 同一算法，Node 实现 |
| 回复验证码 | `tokens.json` | 同结构（但不再用后即焚） |
| 回复校验 | 白名单 + 任务号 + 验证码 + 去重 + 拒附件 + 长度 | 完全相同 |
| 续聊提交 | `start_turn`（能力不足则暂停） | `agent.followup()`（Harness 自己负责排队） |
| 直接回答等待输入 | `answer_user_input` | **不使用**——见下 |
| 凭据 | Windows 凭据管理器 | Harness 凭据服务（`ctx.credentials`） |
| 进程生命期 | 独立后台服务 + 托盘 + 开机自启 | 随 Harness 进程（不需要托盘与自启） |

### 有意的差异

1. **不直接回答结构化的等待输入。** Harness 的 `ctx.userQuestions.answer()` 要求按问题 id 提交结构化答案（每题一项）。邮件正文是自由文本，要把它映射成选项就得猜你选的是哪个——猜错比不猜糟。所以插件把这类回复当作普通下一条消息提交，并在邮件里写明「本插件不会替你选择选项」。参考实现同样有「能力不足时降级为普通消息」的路径，这里只是永远走那条路径。

2. **修复了原版的一个缺陷（任务号正则）。** 原版渲染出的正文是 `本地任务编号：task-xxxx`，但它的任务号正则是 `(?:任务|task)\s*[:：#]`，要求冒号紧跟「任务」。实测 `TASK_RE.search(render_notification(...))` 返回 `None`——也就是说，**用户按邮件里的说明照做、把正文那行原样留着回复，会被判 `task_id_missing` 拒收**。本插件接受 `任务:`、`任务：`、`任务编号：`、`本地任务编号：`、`task:`、`task id:` 等全部写法，并有回归测试覆盖。

3. **修复了原版的另一个缺陷（只搜未读邮件）。** 原版（以及本插件最初）用 `UNSEEN SUBJECT "[Codex]"` 搜索回复，**只看未读邮件**。但回复完全可能以「已读」状态送达——凡是把会话保持打开的邮件客户端，都会把新到的消息标为已读，**QQ 网页版正是如此**。这种情况下的失败是静默且彻底的：那封回复在插件眼里根本不存在。实测证据：一封真实回复出现在 `SUBJECT "[DSH]"` 的 40 条结果里，却完全不在 `UNSEEN SUBJECT "[DSH]"` 的结果里。现在改为 `SINCE <3 天前> SUBJECT "<标签>"`（不再限定未读），靠 Message-ID 去重控制开销，并用 `SINCE` 把窗口收窄——验证码本身只有 24 小时有效，更旧的邮件本来也不可能通过校验。

4. **实测发现 QQ 邮箱的 IMAP 忽略文本搜索条件，因此在本地也做一次主题过滤。** 用裸 IMAP 命令直接问服务器：`UID SEARCH TEXT "ZZZQQQNOPE"`（邮箱里根本不存在的字符串）与 `UID SEARCH SUBJECT "[DSH]"` 返回**完全相同**的一批 UID——文本条件被忽略；而 `UNSEEN` 与 `SINCE` 正常生效。所以真正起作用的是 `SINCE`，`SUBJECT` 基本是摆设。插件因此**在收到邮件后再本地校验一次主题是否含队列标签**，否则日期窗口内的所有无关邮件都会被送进校验器并写审计。

5. **验证码不再「用后即焚」。** 原版与最初的移植版都在第一次成功回复后作废验证码，于是**同一封通知邮件只能回复一次**——你想到第二句、或想在 agent 干活时补一句，就只能干等下一封通知。实测中这表现为 51 秒后的第二次回复被判 `token_already_used`。现在验证码在 24 小时内**可重复使用**：真正的授权是白名单发件人，同一封邮件重复投递由 Message-ID 去重挡住，用量的上界由频率限制与有效期兜住。邮件里的措辞也从「一次性验证码」改成了「回复验证码（24 小时内可多次回复）」。

### 响应延迟

回复从发出到出现在会话里，延迟由三段构成：邮件投递（约 1–5 秒）、下一次轮询的等待（0 到 `pollIntervalMs`）、以及本轮 IMAP 的开销。

最后一段曾经是大头：**每轮都会把搜索窗口里的邮件整封重新下载一遍**，而 UID 是升序的——你的回复作为最新邮件排在最后，所以要先白取完前面 50 封才轮到它。实测：

| | 耗时 |
|---|---|
| 连接 + 登录 + SELECT | 510 ms |
| 每封邮件 FETCH | ~117 ms |
| 每轮取 50 封（旧行为） | **5873–6176 ms** |
| 每轮只取新邮件（现行为） | **613–663 ms** |

现在插件在 `state.json` 里记录已处理到的最高 UID（`imap_mark`），每轮只请求比它更新的邮件。若邮箱的 UID 重新编号（UID 变小），插件会识别出来、重新扫描一次窗口并重新基线化，不会静默漏信。默认轮询间隔因此从 30 秒降到 15 秒——每轮便宜了，就能问得更勤。

想让回复更快出现，可以继续调小 `pollIntervalMs`（下限 5000）；代价是更频繁的 IMAP 登录。

### 排查回复为什么没生效

`scripts/check-mailbox.mjs` 以只读方式跑**同一套搜索与校验**，逐封告诉你「这封回复会不会被接受」、解析出的任务编号、以及验证码是否仍然有效——**不消耗验证码、不标记已读、不打印正文**：

```powershell
& $node .\scripts\check-mailbox.mjs
```

### 校验用整封邮件，投递只用你写的字

这两件事刻意分开，因为合在一起会二选一地出错：

- **校验（任务号 + 验证码）针对整封邮件，包括被引用的原文。** 通知里让你「保留上面的任务编号与验证码」，而邮件客户端会把它们放进引用块里——只搜清理后的正文，恰好会拒掉说明里要求的这种回复。
- **投递到会话的只有你自己写的内容。** 早期版本会把整段引用一起交给模型：一封真实回复实测投递了 **1285 字符**，其中用户自己只写了一句 12 字的话。现在 `---原始邮件---`、`----- 转发邮件 -----`、`发件人：`、`发送时间：`、`____`、`----` 等分隔符都会截断正文（原版只认 `在…写道：` 与 `On … wrote:`）。
- 另外会解码字面量 HTML 实体：QQ 生成的纯文本部分是把 HTML 去掉标签却**不解码实体**，正文里会带着 `&nbsp;` 这样的六个字符，直接投递给模型既难看又是噪声。

## 开发与测试

零运行时依赖，只用 Node 内置模块。

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$files = Get-ChildItem .\test -Recurse -Filter *.test.js | % FullName
& $node --test --test-isolation=none @files
```

> 在 DSH 沙箱内 `node --test <目录>` 会因为管道 stdio 报 `spawn EPERM`；显式列出测试文件并加 `--test-isolation=none` 可以在单进程内运行。

测试覆盖：领域状态机与非法迁移、原子落盘、队列退避与崩溃恢复、回复校验的全部拒收理由、主题/正文编解码与 MIME 解析、SMTP 与 IMAP 协议对话（对着真实的本地 TLS 服务器，含自签证书、AUTH LOGIN、字面量框架、点填充、4xx/5xx 分类）、桥接事件映射、回复路由、端到端（任务 → 邮件 → 回复 → 路由）、profile 与凭据文件的文本编辑器、以及脚本本身的往返与「绝不泄露凭据文件」回归。

`DSH_YAML_MODULE` 指向一个 YAML 模块时，编辑器测试会额外用真实 YAML 解析器校验生成的文档：

```powershell
$env:DSH_YAML_MODULE = "<path to yaml/dist/index.js>"
```

## 卸载

```powershell
# 只停用（保留依赖、凭据与数据）
node scripts\uninstall.mjs

# 连凭据一起移除
node scripts\uninstall.mjs --remove-credential

# 连依赖与插件数据一起移除
node scripts\uninstall.mjs --remove-credential --remove-dependency --purge-data
```

卸载同样会先备份。之后重启 Harness。

## 已知限制

- **发送已实测，回复续聊尚未实测。** 已经验过：174 项自动化测试（含对着真实本地 TLS 服务器的 SMTP/IMAP 对话）、profile 结构性校验、插件在替身上下文里的启动冒烟、以及**真实 QQ 邮箱的连续 10 封通知投递成功**（`notification.sent` 全部落盘）。**还没验过的是回复链路**——即「回复邮件 → 校验通过 → 原会话收到内容」，需要人为回复一封通知邮件才能确认。
- **凭据解析有一条兜底路径。** 实测中凭据服务（`ctx.credentials`）在插件首次读取时未能返回该引用，而托管文档里明明有——插件因此回退到直接读 `~/.dsh/.credentials.yaml`（只读），并在审计里记一条 `credential.fallback`。这条路径是必要的，但意味着凭据的写入仍归凭据服务与 `set-credential.mjs`，插件自身从不写它。
- **拒收的邮件会留在收件箱且保持未读**（与参考实现一致），因此每一轮轮询都会把它们取回来。已检查过的 Message-ID 会被静默跳过，不再重复记审计——但如果收件箱里长期堆积大量 `[DSH]` 主题的旧邮件，每轮仍会做一次取回开销（上限 25 封）。清理掉那些旧邮件即可。
- **`X-Agent-Mail-Notify` 邮件头是识别「自己发的通知」的首要标记**，`@dsh-mail-notify` 的 Message-ID 域名是第二重保险。两者都失效时，自己的通知理论上可能被当成有效回复——它会包含任务号与有效验证码。目前实测未出现。
- **只在 Windows 上验证过。** 代码只用 Node 内置模块，理论上跨平台，但未在 macOS / Linux 上运行过。
- **`dataDir` 的存在意义有限**：数据目录默认 `<DSH_HOME>/mail-notify`，`config.dataDir` 会覆盖它。
- **没有图形设置界面。** 配置走 `configure.mjs`；Harness 设置界面里能看到凭据是否已设置，但不会显示它的值。
- **发信不加密正文**：与参考实现一致，邮件是明文（依赖 SMTP 的 TLS 传输加密）。摘要里不要放机密——它本来也只发摘要。
