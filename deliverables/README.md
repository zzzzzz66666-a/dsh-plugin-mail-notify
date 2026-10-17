# DeepSeek Harness 邮件通知插件 · 发布包

给 **DeepSeek Harness 桌面版**用的邮件通知插件：一轮任务结束时发摘要邮件，**直接回复那封邮件**就能继续原对话。

版本 1.0.0 · 平台：Windows · 通道：QQ 邮箱（含腾讯企业邮箱）

---

## 这个文件夹里有什么

| 文件 | 给谁 | 说明 |
| --- | --- | --- |
| `dsh-plugin-mail-notify-1.0.0.zip` | 使用者 | 插件本体。解压到固定目录即可 |
| `SHA256.txt` | 使用者 | 上面的 zip 的校验值 |
| `dsh-plugin-mail-notify-1.0.0.sha256.json` | 维护者 | 同一校验值 + 文件数、字节数、排除项等构建信息 |
| **`使用说明.md`** | **使用者** | **先看这个**。安装、配置、日常用法、回复规则、排障 |
| `skill\dsh-mail-notify-install\` | 使用者的 AI 助手 | 安装技能：装到 Harness 技能目录后，对助手说「帮我装」即可 |
| `dsh-plugin-mail-notify-install-skill.zip` | 使用者 | 上面那个技能目录的压缩包，方便单独分发 |
| `packaging-check.json` | 维护者 | 本次打包的校验记录（确定性重建、回读 CRC、技能包校验） |

---

## 两条安装路径

### A. 交给 AI 助手（推荐）

把技能装到 Harness 的技能目录，重启会话后直接说「帮我装 DeepSeek Harness 邮件通知插件」：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills" | Out-Null
Copy-Item -Recurse '.\skill\dsh-mail-notify-install' "$env:USERPROFILE\.dsh\skills\"
```

技能会自己完成配置与校验，并把唯一需要你亲自做的事（输入邮箱授权码）交给你——**授权码不会经过对话记录**。

### B. 自己装

见 `使用说明.md` 的「3.2 自己装」。三步：写配置 → 存授权码 → 结构校验 → **完全重启 Harness**。

---

## 前置条件

- Windows 10 / 11
- DeepSeek Harness **桌面版**已安装并使用过
- 一个 QQ 邮箱，并在邮箱设置里开启「IMAP/SMTP 服务」拿到 16 位授权码

`node` 不需要单独安装——用 Harness 自带的那份：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
```

---

## 校验下载完整性

```powershell
Get-FileHash .\dsh-plugin-mail-notify-1.0.0.zip -Algorithm SHA256 | Select-Object -ExpandProperty Hash
# 应与 SHA256.txt 里的值一致
```

---

## 关键设计（值得知道的几条）

- **权限审批永远不能通过邮件批准。** 这是硬性设计，不是遗漏。
- **授权码只进 Harness 凭据服务**，不进配置、日志、审计。审计日志写入前会脱敏。
- **只发摘要**，不发完整模型输出。
- **验证码 24 小时内可重复使用**，但同一封邮件只会被处理一次。
- 每次改动 profile 或凭据文件前都会**先备份**，卸载脚本可整体还原。
- 插件随 Harness 进程运行，**没有**独立后台服务、托盘图标或开机自启项。

---

## 已知限制

1. Harness 完全退出后不会提醒。
2. 不能替你回答结构化的选择题（自由文本无法可靠映射到选项），这类回复作为普通下一条消息提交。
3. 只在 Windows 上验证过。
4. 首版只支持一个收件邮箱、一个允许回复邮箱，以及 SMTP/IMAP。
5. 短信通知未实现。

细节与排障见 `使用说明.md` 与 `skill\dsh-mail-notify-install\references\troubleshooting.md`。

---

## 许可

MIT。见插件包内 `LICENSE`。
