# 排障 · dsh-plugin-mail-notify

每个现象都对应到**具体命令**和**要看的文件**。先查证据，再下结论。

统一变量（下面命令都用它们）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pkg  = '<包根>'                                    # 含 package.json 的那层
$home_ = "$env:USERPROFILE\.dsh"
$data = "$home_\mail-notify"
```

三个证据源：

| 文件 | 里面有什么 |
| --- | --- |
| `$data\audit.json` | 发生了什么（`service.start`、`notification.sent`、`reply.route`、`reply.reject`…），已脱敏 |
| `$data\notifications.json` | 通知队列：`status`（pending/sent/retrying/failed）、`retryCount`、`lastError` |
| `$data\state.json` | `notified_tasks`、`task_sessions`、`seen_message_ids`、`imap_mark` |

查看审计的最稳写法（PowerShell 5.1 下 `Format-Table` 容易渲染成空表，用 `ForEach-Object`）：

```powershell
$r = Get-Content "$data\audit.json" -Raw | ConvertFrom-Json
$r | Select-Object -Last 30 | ForEach-Object { "{0}  {1,-22} {2}" -f $_.createdAt, $_.action, $_.result }
```

---

## 1. 插件似乎完全没反应

```powershell
& $node "$pkg\scripts\verify-install.mjs"
```

| 结果 | 判断 |
| --- | --- |
| 不是 14/14 | 按未通过的那一项修；`the installed package resolves` 失败通常是依赖没装（重跑 `configure.mjs`） |
| 14/14 但 `audit.json` 不存在 | 没重启，或重启没加载。确认进程启动时间晚于安装时间 |
| `service.start` 的 result 是 `not configured` | 往下看第 2 节 |

---

## 2. `not configured`（凭据没读到）

先看紧随其后的 `credential.diagnose` 记录——它写明选中的存储与各条查找路径的结果：

```powershell
$r | Where-Object { $_.action -like 'credential.*' } | Select-Object -Last 5 |
  ForEach-Object { "{0}  {1}  {2}" -f $_.createdAt, $_.action, $_.result }
```

| 看到什么 | 含义与处理 |
| --- | --- |
| `credential.fallback` 后接 `credential.loaded` | **正常**。凭据服务首次读取时还没就绪，文件兜底顶上，随后凭据服务也解析成功。不用管 |
| `credential.missing` + `diagnose` 里 `store: memory` | 凭据服务和文件都不可达。查 `%USERPROFILE%\.dsh\.credentials.yaml` 是否存在、`refs:` 下有无 `DSH_MAIL_NOTIFY_AUTH_CODE` |
| `credential.missing` + `diagnose` 里 `store: credentials-file` | 文件读到了但解析不出该引用。用下面这条确认键名拼写 |

确认引用是否真的存着（**只看键名，不要打印值**）：

```powershell
Select-String -Path "$home_\.credentials.yaml" -Pattern '^\s+DSH_MAIL_NOTIFY_AUTH_CODE\s*:' | ForEach-Object { "found at line $($_.LineNumber)" }
```

修复：重跑 `set-credential.mjs` 写入授权码，然后重启。

---

## 3. 登录失败（`set-credential.mjs` 报错）

| 错误分类 | 含义 | 处理 |
| --- | --- | --- |
| `authentication: the authorization code was rejected` | 授权码错，或 IMAP/SMTP 服务没真正开启 | 回 QQ 邮箱重新生成授权码；确认「IMAP/SMTP 服务」状态是开启 |
| `tls: ...` | 证书/TLS 握手失败 | 网络中间设备或代理拦截；换网络再试 |
| `transient: ...` | 超时、连接被拒、服务器临时故障 | 网络问题，不是授权码问题 |

只想复测已存的授权码、不想重新输入：

```powershell
& $node "$pkg\scripts\set-credential.mjs" --check-only
```

---

## 4. 收不到通知邮件

按顺序查：

```powershell
# 4.1 队列里有没有这条通知
Get-Content "$data\notifications.json" -Raw | ConvertFrom-Json |
  ForEach-Object { $_.PSObject.Properties } |
  ForEach-Object { "{0}  status={1}  retry={2}  lastError={3}" -f $_.Name, $_.Value.status, $_.Value.retryCount, $_.Value.lastError }
```

| `status` | 含义 |
| --- | --- |
| `sent` | 已交给服务器。收不到就是投递侧问题（垃圾箱、收件规则、地址写错） |
| `pending` / `retrying` | 还没发成功，看 `lastError` 与 `nextRetryAt` |
| `failed` | 重试用尽。`lastError` 会写分类：`authentication` 是授权码问题，`transient` 是网络，`permanent` 是服务器拒收 |

```powershell
# 4.2 审计里有没有 enqueue / sent
$r | Where-Object { $_.action -like 'notification.*' -or $_.action -eq 'imap.receive' } |
  Select-Object -Last 10 | ForEach-Object { "{0}  {1,-22} {2}" -f $_.createdAt, $_.action, $_.result }
```

- 完全没有 `notification.enqueue` → 插件没识别到轮次结束。确认 `service.start` 是 `configured`；确认那一轮是**正常结束**（`aborted` / `interrupted` / `forked` 按设计不发信）。
- 有 `notification.enqueue` 没有 `notification.sent` → 发信环节失败，看队列的 `lastError`。

**注意**：`notification.sent` 表示 SMTP 服务器接受了这封信，不保证对方收到。QQ 邮箱之间偶有延迟，等 1–2 分钟；仍收不到就查垃圾邮件目录。

---

## 5. 回复了但没进对话（最常见）

**先跑只读诊断**，它会用和插件完全相同的搜索与校验逻辑，逐封告诉你「会不会被接受」：

```powershell
& $node "$pkg\scripts\check-mailbox.mjs"
```

它不消耗验证码、不标记已读、不打印正文。

### 5.1 诊断里根本没有你发的那封回复

说明**没搜到**。逐条排查：

| 原因 | 判断 | 处理 |
| --- | --- | --- |
| 邮件在「已发送」而不在收件箱 | 用邮件客户端确认 | 需要它出现在 INBOX；自己发给自己的回复通常会进收件箱 |
| 主题里没有队列标签 | 默认标签是 `[DSH]`，回复主题应为 `Re: [DSH]…` 或 `回复：[DSH]…` | 别手工改回复主题 |
| 早于搜索窗口（默认 3 天） | 看回复时间 | 验证码本身只有 24 小时有效，太旧的本来也过不了校验，重发一封新回复即可 |
| 不在 `INBOX` | 邮箱规则把它挪走了 | 改 `--imap-mailbox`，或调整邮箱规则 |

> **已知的服务器怪癖**：QQ 邮箱的 IMAP **忽略 `SUBJECT` / `TEXT` 这类文本搜索条件**（实测：`TEXT "不存在的串"` 与 `SUBJECT "[DSH]"` 返回同一批 UID），只有 `SINCE`、`UNSEEN` 生效。所以插件靠 `SINCE` 限定窗口，并在取回后**本地再校验主题含标签**。如果你换了别的邮箱服务商、发现搜不到，这是要想到的一层。

### 5.2 诊断说「会被拒绝（原因）」

| 原因 | 含义 | 处理 |
| --- | --- | --- |
| `sender_not_allowed` | 发件地址不在白名单 | 用配置里 `allowedReplyEmail` 那个地址发；或改配置 |
| `task_id_missing` | 正文里找不到任务编号 | 回复里要保留 `本地任务编号：task-xxxx` 这一行 |
| `token_missing` | 找不到验证码 | 保留 `回复验证码：XXXXXXXX` 这一行 |
| `token_invalid` | 任务编号与验证码对不上 | 别把两封不同邮件的编号和验证码混在一起 |
| `token_expired` | 超过 24 小时 | 等下一封新通知，或让 Harness 再跑一轮 |
| `attachments_not_allowed` | 带了附件 | 去掉附件 |
| `body_too_long` | 正文超长 | 默认上限 8000 字符（剥离引用后计算） |
| `duplicate_message_id` | 这封邮件已经处理过 | 正常：同一封邮件只处理一次。想再发就新起一封回复 |

### 5.3 诊断说「会被接受」，但对话里没有

说明校验过了、卡在投递环节。看审计：

```powershell
$r | Where-Object { $_.action -like 'reply.*' } | Select-Object -Last 10 |
  ForEach-Object { "{0}  {1}  {2}  task={3}" -f $_.createdAt, $_.action, $_.result, $_.taskId }
```

| `reply.route` 的 result | 含义 |
| --- | --- |
| `submitted` | 已交给会话，会立刻开始新一轮 |
| `submitted_running` | 会话当时正在跑，消息排进收件箱，**当前轮结束后**才开始新一轮。看起来像"没反应"，实际在排队 |
| `queued_approval` | 会话正在等权限审批。按设计回复先排队——**邮件永远不能批准权限** |
| `queued_missing_session` | 原会话已经不在内存里（例如 Harness 重启后没恢复它）。回复留在内存队列，等该会话活过来才提交 |
| `paused` / `rate_limited` | 全局暂停中，或触发了每分钟 20 条的频率上限 |
| 完全没有 `reply.*` 记录 | 没走到路由，回 5.1 或 5.2 |

**还有一种情况**：`seen_message_ids` 里已经记过这封邮件的 Message-ID（比如它曾被拒），插件会**静默跳过**、不再记审计。想让它重新处理，只能重发一封新的回复。

---

## 6. 通知发得太慢 / 重复的审计记录

### 6.1 回复很久才进对话

正常延迟 = 邮件投递（1–5 秒）+ 等待轮询（0 到 `pollIntervalMs`）+ 本轮 IMAP 开销。

现在的实现只取新邮件（`state.json` 里的 `imap_mark`），每轮开销约 0.6 秒，`pollIntervalMs` 默认 15 秒。
若明显更慢：检查 `state.json` 里 `imap_mark` 是否长期不变、审计里有没有 `imap.receive` 错误。
也别忘了 `submitted_running` 那种排队情况（见 5.3）——那是会话忙，不是插件慢。

### 6.2 审计里大量 `reply.reject duplicate_message_id`

说明那些邮件被反复取回又反复判定。当前实现会**静默跳过已检查过的 Message-ID**，不该再刷。
若仍出现，可能是旧版本残留的审计记录——清掉审计文件即可（下一次启动会重建）：

```powershell
Remove-Item "$data\audit.json"
```

### 6.3 `imap.rebaseline`

邮箱的 UID 重新编号了（UID 变小）。插件会自动重扫一次窗口并重新基线化，**这是自愈行为**，不用处理。
但若频繁出现，说明邮箱服务端在反复重置 UID，值得观察。

---

## 7. 彻底重来

```powershell
# 停止 Harness 后
& $node "$pkg\scripts\uninstall.mjs" --remove-credential --remove-dependency --purge-data
# 重新安装
& $node "$pkg\scripts\configure.mjs" --sender <邮箱> --no-credential
Get-Content .\code.txt | & $node "$pkg\scripts\set-credential.mjs"
& $node "$pkg\scripts\verify-install.mjs"
```

`uninstall.mjs` 改动前同样会备份到 profile 目录下的 `.mail-notify-uninstall-<时间戳>\`。
