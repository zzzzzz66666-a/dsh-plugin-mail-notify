---
name: dsh-mail-notify-install
description: Install, configure, verify, repair, or uninstall the DeepSeek Harness mail notification plugin (dsh-plugin-mail-notify) on Windows — the plugin that emails a summary when a Harness turn ends and lets the user reply to that mail to continue the same session. Use when the user wants an email when a Harness task finishes or fails, wants to be notified while away from the Harness window, wants to reply to a notification email to continue the original conversation, or asks to install / set up / 配置 / 安装 / 卸载 DeepSeek Harness 邮件通知插件 / 发邮件提醒.
---

# dsh-plugin-mail-notify 安装器

这是一份**给别人（用户的 AI 助手）执行**的安装说明，不是开发文档。开发者视角见插件包内的 `README.zh.md`；
排障细节见 `references/troubleshooting.md`；交给用户的日常说明是同一发布目录下的 `使用说明.md`。

**目标**：让 DeepSeek Harness 在一轮任务结束时发一封摘要邮件，并允许用户**直接回复那封邮件**把内容送回原会话。

---

## 会被安装什么

- 一条**插件行**写进 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，一行 `link:` 依赖写进同目录的 `package.json`。
- 插件随 Harness 进程运行（**没有**独立后台服务、托盘图标或开机自启项）。
- 轮次结束发摘要邮件；`approval/asked` 与 `ask_user_question` 可发等待提醒。
- 本机持久通知队列（指数退避、5 次自动重试、重启恢复、幂等）。
- IMAP 回复校验：白名单发件人、任务编号、回复验证码、24 小时有效期、Message-ID 去重、拒附件、长度上限、剥离引用与签名。
- 邮箱授权码只写进 Harness 凭据服务（`%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs:` 分节，引用名 `DSH_MAIL_NOTIFY_AUTH_CODE`），**不写进任何配置、日志或审计**。

## 你必须遵守的规则

1. **绝不打印、回显或在命令行里直接传授权码。** 让用户自己把验证码存进临时文件，再用管道喂给 `set-credential.mjs`；结束后提醒用户删除该文件。若用户坚持在对话里输入，警告它会留在对话记录里。
2. **绝不绕过或削弱 Harness 的沙箱与审批。** 邮件永远不能批准权限请求——这是插件的硬性设计，不要试图"修复"它。
3. **只改 Harness 自己的 profile 与凭据文件，以及插件自己的数据目录。** 不要动用户的项目文件。
4. **没跑验证就不要声称成功。** 必须实际执行 `verify-install.mjs` 并把结果展示给用户。
5. **重启由用户决定。** 不要擅自杀掉用户的 Harness 进程——那会中断他正在进行的会话。把重启命令交给用户执行。
6. **改动前先 `--dry-run`。** `configure.mjs` 支持它，先让用户看清将要写入什么。

## 包结构

发布目录通常长这样：

```text
deep seek通知插件\
  dsh-plugin-mail-notify-1.0.0.zip      <- 插件包（解压到任意固定目录）
  SHA256.txt                            <- 校验值
  使用说明.md                            <- 交给用户的日常说明
  skill\dsh-mail-notify-install\         <- 本文件所在目录
```

用户若给的是 zip，先解压。**包根**是含 `package.json`、`lib\index.js`、`scripts\configure.mjs` 的那层目录。

## 工作流

### 第 0 步 · 确认前置条件（每条都有判据，不要跳过）

| 要确认 | 判据 | 不满足时 |
| --- | --- | --- |
| 是 Windows 桌面版 Harness | `Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"` 为 `True` | 路径不同就用 `--profile` 指定；完全没有则说明用户没装桌面版 |
| 找到 node | `& $node -v` 能打印版本 | 用 Harness 自带的：`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| 包根正确 | `Test-Path '<包根>\scripts\configure.mjs'` 为 `True` | 没有就先解压 zip |

> **`node` 通常不在 PATH 里。** 一律用 Harness 自带的那条绝对路径：
> ```powershell
> $node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
> ```

### 第 1 步 · 只读预览将要写入的改动

```powershell
cd '<包根>'
& $node .\scripts\configure.mjs --sender <发件邮箱> --auth-code dummy --dry-run
```

**判据**：

1. 输出里 `cordis.patch.yml` 段落**新增**一个 `- insert:` 块，内含
   `- id: mail-notify` 与 `name: 'dsh-plugin-mail-notify'`；
2. 原有的其它插件条目（例如 `ui-frosted-glass`、`ui-settings-account`）**一行不少**；
3. 凭据段落只写"would add/replace refs.DSH_MAIL_NOTIFY_AUTH_CODE = [REDACTED]"，**不打印凭据文件内容**。

**第 3 条尤其重要**：`.credentials.yaml` 里存着这台机器所有凭据，任何情况下都不要把它打印出来。

### 第 2 步 · 收集配置（只问这四项）

1. 发件邮箱地址（QQ 邮箱即可）。
2. 收件邮箱地址（可与发件相同）。
3. 允许回复的邮箱地址（默认与收件相同）。
4. **QQ 邮箱授权码**：QQ 邮箱 → 设置 → 账户 → 开启「IMAP/SMTP 服务」→ 按短信提示生成。
   并明确告诉用户：**这不是 QQ 密码**，是 16 位左右的授权码。

服务器默认值已内置为 QQ 邮箱正确值（`smtp.qq.com:465/ssl`、`imap.qq.com:993/ssl`），无需询问。
腾讯企业邮箱用 `--smtp-host smtp.exmail.qq.com --imap-host imap.exmail.qq.com` 覆盖。

### 第 3 步 · 写配置（不碰授权码）

```powershell
cd '<包根>'
& $node .\scripts\configure.mjs --sender <发件邮箱> --no-credential
```

**判据**：

1. 退出码 `0`；
2. 输出含 `plugin row     mail-notify written to cordis.patch.yml`；
3. 输出含 `install        installed`（若显示 `pnpm-not-found`，按输出里给的命令手工跑一次 pnpm）；
4. **把输出里的 `backup <路径>` 记下来**——回滚要用。

可选参数：`--recipient`、`--reply-to`、`--prefix`、`--imap-mailbox`、`--data-dir`、`--profile`。

### 第 4 步 · 写入授权码（用户自己执行，或经管道）

推荐让用户自己建临时文件再管道输入，**验证码不出现在命令行和对话里**：

```powershell
# 用户在自己终端里：把授权码写进 code.txt（只有一行），然后
cd '<包根>'
Get-Content .\code.txt | & $node .\scripts\set-credential.mjs
Remove-Item .\code.txt
```

脚本会：写进 Harness 凭据服务 → **立刻用这个授权码实测 SMTP 与 IMAP 登录** → 打印 `ok SMTP login` / `ok IMAP login`。

**判据**：两行都是 `ok`，退出码 `0`。

失败时按 `references/troubleshooting.md` 的「登录失败」一节处理：`authentication` 类错误说明授权码不对或 IMAP/SMTP 服务没真正开启；
`transient` / `tls` 类错误是网络或代理问题，不是验证码问题。

### 第 5 步 · 安装结构校验

```powershell
& $node .\scripts\verify-install.mjs
```

**判据**：**14/14 checks passed**，退出码 `0`。它逐项验证依赖解析、宿主入口可 import、
插件能在替身上下文里启动、监听已注册、profile patch 行存在、配置合法、凭据已存储。

### 第 6 步 · 让用户完全重启 Harness（不能省）

桌面版**没有热重载**，关窗口不算，必须完全退出进程再启动。
**不要替用户杀进程**——把这句交给他：

> 请完全退出 DeepSeek Harness（含托盘/任务管理器里的残留进程）再重新打开。

### 第 7 步 · 确认它真的活着（必须做，否则等于没装）

```powershell
$dir = "$env:USERPROFILE\.dsh\mail-notify"
$r = Get-Content "$dir\audit.json" -Raw | ConvertFrom-Json
$r | Where-Object { $_.action -eq 'service.start' } | Select-Object -Last 1
```

**判据**：最新一条 `service.start` 的 `result` 是 **`configured`**。

- 没有 `audit.json` → 插件没加载。回第 5 步。
- `result` 是 `not configured` → 看紧随其后的 `credential.diagnose` 记录，它写明了选中的存储与各条查找路径的结果。
- 出现 `credential.fallback` 是**正常**的：说明凭据服务首次读取时还没就绪，文件兜底顶上；紧接着的 `credential.loaded` 表示随后凭据服务也解析成功。

### 第 8 步 · 如实汇报，并交付用户手册

汇报这几项：插件目录、数据目录、`verify-install` 结果、`service.start` 是否为 `configured`、授权码登录是否两路都 `ok`。

然后把同一发布目录下的 **`使用说明.md`** 交给用户——里面有日常用法、回复规则与排障表。

---

## 常见任务

| 目标 | 命令（在包根下执行） |
| --- | --- |
| 看安装结构 | `& $node .\scripts\verify-install.mjs` |
| 复测已存授权码是否还有效 | `& $node .\scripts\set-credential.mjs --check-only` |
| 排查「回复了但没进对话」 | `& $node .\scripts\check-mailbox.mjs` |
| 改邮箱地址 | `& $node .\scripts\configure.mjs --sender <新地址> --no-credential` |
| 换授权码 | 重跑第 4 步 |
| 临时停用插件（保留依赖/凭据/数据） | `& $node .\scripts\uninstall.mjs` |
| 彻底清理 | `& $node .\scripts\uninstall.mjs --remove-credential --remove-dependency --purge-data` |
| 跑插件自测（187 项） | `& $node .\scripts\run-tests.mjs` |

`check-mailbox.mjs` 是**只读**的：不消耗验证码、不标记已读、不打印正文，只告诉你「这封回复会不会被接受」。

---

## 排障

**先读 `references/troubleshooting.md`**，再向用户下结论。它把每个现象映射到具体的命令和要看的文件。
最常见的三个：

| 现象 | 先查 |
| --- | --- |
| 收不到通知邮件 | `%USERPROFILE%\.dsh\mail-notify\notifications.json` 的 `status` 与 `lastError`；`audit.json` 里的 `notification.sent` / `imap.receive` |
| 回复了但没进对话 | 先跑 `check-mailbox.mjs` 看它是「没搜到」还是「搜到了但校验没过」 |
| 插件似乎没加载 | `verify-install.mjs` 是否 14/14；`audit.json` 有无 `service.start` |

---

## 边界（不要承诺做不到的事）

| 做不到 | 原因 |
| --- | --- |
| 用邮件批准权限 | 硬性设计：审批必须回到 Harness 内操作 |
| 在没有 Harness 进程时提醒 | 插件随进程运行，进程没了插件也不在了 |
| 直接回答结构化的等待输入 | Harness 要求按问题 id 提交结构化答案，自由文本无法可靠映射；这类回复会作为普通下一条消息提交 |
| 支持裸 SMTP/IMAP 之外的传输 | 首版只做 SMTP 与 IMAP（`ssl` / `starttls`） |
| 在 macOS / Linux 上验证 | 代码只用 Node 内置模块，理论上跨平台，但只在 Windows 上验证过 |

## 把这个技能永久装到本机

技能目录是 **`%USERPROFILE%\.dsh\skills`**（Harness 的用户级技能根）。复制进去后重启 Harness 会话即可被识别：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
Copy-Item -Recurse '<发布目录>\skill\dsh-mail-notify-install' "$env:USERPROFILE\.dsh\skills\"
```

删掉该文件夹只卸载技能，已安装的插件继续工作。
