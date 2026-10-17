# dsh-plugin-mail-notify

A DeepSeek Harness plugin that **emails a summary when a turn ends** and, after strict verification, **lets a reply to that mail continue the same session**.

It is the harness-native port of the Codex mail notification component in this workspace (`src/codex_notify`, Python): the same outbound queue, the same reply-code gate, and the same refusal to approve anything by mail. The difference is that it no longer polls a Codex thread history — it subscribes to the harness's own session event stream.

## What it does

- **Turn-end notifications** for turns ending `completed`, `error`, `blocked` or `max-tokens`. `aborted`, `interrupted` and `forked` are deliberately silent.
- **Waiting-state notifications**: `approval/asked` reports "waiting for approval"; an `ask_user_question` tool call reports "waiting for your answer" and puts the questions and their options in the mail body.
- **Summaries, never transcripts**: status, title, local task id, session id digest, start/end time, duration, a capped reply summary, error summary, reply code and reply instructions.
- **Durable queue**: JSON on disk, exponential backoff (`2^n` s, capped at 300 s), five automatic attempts, manual retry, restart recovery, crash recovery from `sending`, idempotent by notification id.
- **Strict reply gate**: allow-listed sender, task id, reply code (24 h, reusable within that window), Message-ID dedup, attachments refused, body length cap, quoted history and signature stripped. Anything that fails is **not** marked read in your mailbox.
- **Routing**: an accepted body goes back through `agent.followup()` — a new turn when idle, queued in the harness inbox while running.
- **Approvals are never granted by mail.**

## Install

```powershell
node scripts\configure.mjs --no-config    # dependency + plugin row + pnpm link
node scripts\verify-install.mjs           # 13 structural checks
# then fully restart DeepSeek Harness
```

`configure.mjs` backs up the profile manifest, patch and credential file into
`<profile>\.mail-notify-backup-<timestamp>\` before writing, and never restarts your app. Installed but unconfigured, the plugin loads, registers its listeners, reports `configured: false` and stays idle.

## Configure

```powershell
Get-Content .\code.txt | node scripts\configure.mjs --sender you@qq.com --auth-code-stdin
node scripts\configure.mjs --sender you@qq.com --no-credential   # config only
node scripts\configure.mjs --sender you@qq.com --auth-code x --dry-run
```

Defaults are already correct for QQ mail (`smtp.qq.com:465/ssl`, `imap.qq.com:993/ssl`); override with `--smtp-host`, `--imap-host`, `--smtp-port`, `--smtp-security` (`ssl`/`starttls`), `--prefix`, `--data-dir`, `--profile`, `--home`, `--credentials`.

The authorization code goes to the harness credential service under the reference
`DSH_MAIL_NOTIFY_AUTH_CODE` (in `<DSH_HOME>/.credentials.yaml` under `refs:`), never into a configuration file. Rotating it takes effect on the next request.

## Security model

| Concern | Handling |
|---|---|
| Authorization code | `ctx.credentials` only; absent from config, logs, audit and `--json` output |
| Mail body | summary only — never the full model output |
| Who may continue a session | allow-listed address **and** task id **and** reply code |
| Reply code | 24 h TTL, reusable within it, constant-time comparison |
| Approvals | never granted by mail; replies are queued while one is pending |
| Rate | at most 20 replies/minute (`maxRepliesPerMinute`) |
| Attachments | always refused |
| Audit | redacted before writing (codes, tokens, 8-char uppercase hex) |

## Differences from the Codex version

1. **Structured questions are not auto-answered.** The harness's `ctx.userQuestions.answer()` needs one structured answer per question id. A free-text mail body cannot be mapped onto options without guessing, and guessing wrong is worse than not guessing, so such a reply is submitted as an ordinary next message and the mail says so.
2. **A defect in the reference is fixed (task-id pattern).** The reference renders `本地任务编号：task-xxxx` but its task-id pattern required a colon immediately after `任务`, so a user who followed the instructions and kept that line was rejected with `task_id_missing` (verified against the real code). This plugin accepts `任务:`, `任务：`, `任务编号：`, `本地任务编号：`, `task:` and `task id:`, with regression tests.
3. **A second defect in the reference is fixed (unseen-only search).** The reference — and this port, until it was exercised against a real mailbox — searched replies with `UNSEEN SUBJECT "[Codex]"`, i.e. unread mail only. A reply can arrive **already read**: any client that keeps the conversation open marks the arriving message seen, and QQ web mail does exactly that. The failure is silent and total — the reply does not exist as far as the plugin is concerned. Measured on a real mailbox: a genuine reply was present in the 40 results of `SUBJECT "[DSH]"` and absent from every result of `UNSEEN SUBJECT "[DSH]"`. The search is now `SINCE <3 days ago> SUBJECT "<tag>"`, de-duplicated by Message-ID and bounded by date — the one-time code is only valid for a day, so older mail could never be accepted anyway.

4. **Measured: QQ Mail's IMAP ignores text search criteria, so the queue tag is enforced locally too.** Asking the server directly with raw IMAP commands, `UID SEARCH TEXT "ZZZQQQNOPE"` — a string that appears nowhere in the mailbox — and `UID SEARCH SUBJECT "[DSH]"` return the *same* UID list, while `UNSEEN` and `SINCE` behave correctly. Only `SINCE` therefore bounds the search, and the plugin re-checks the subject against the queue tag after fetching; otherwise every unrelated message in the date window would reach the validator and the audit log.

5. **The reply code is no longer burned on first use.** The reference — and this port, until a real reply was rejected — consumed the code at the first successful reply, so **one notification could only ever be answered once**. Adding a second thought, or replying again while the agent was still working, was silently refused: measured as a reply 51 seconds after a successful one, rejected `token_already_used`. The code is now reusable inside its 24 h window. The real authorisation is the allow-listed sender; a redelivered mail is still stopped by Message-ID de-duplication; and the volume is bounded by the rate limit and the TTL. The mail wording changed from "one-time code" to "reply code (usable for 24 h)".

Also: credentials live in the harness credential service rather than the Windows Credential Manager, and there is no tray icon or login autostart because the harness process owns the plugin's lifetime.

### Verification reads the whole mail; delivery carries only what you typed

The two are deliberately separate, because doing both on the same text fails one way or the other:

- **The task id and one-time code are matched against the whole message, quoted original included.** The notification tells the user to keep those lines, and a client that quotes the original puts them inside the quote — matching only the stripped body would reject exactly the reply the instructions ask for.
- **Only the user's own words reach the session.** Earlier versions submitted the entire quote: a real reply delivered **1285 characters** where the user had typed a 12-character sentence. `---原始邮件---`, `----- 转发邮件 -----`, `发件人:`, `发送时间:`, `____` and `----` now all end the body (the reference recognised only `在…写道：` and `On … wrote:`).
- Literal HTML entities are decoded too: QQ builds the text part by stripping tags *without* decoding entities, so bodies arrive containing the six characters `&nbsp;`.

### Response latency

The delay between sending a reply and seeing it in the session has three parts: mail delivery (1–5 s), the wait for the next poll (0 to `pollIntervalMs`), and that poll's own IMAP cost.

The last part used to dominate. **Every poll re-downloaded the entire search window**, and UIDs ascend — so the newest message, your reply, was fetched last, behind fifty older ones. Measured:

| | Cost |
|---|---|
| Connect + login + SELECT | 510 ms |
| One message FETCH | ~117 ms |
| 50 messages per poll (old) | **5873–6176 ms** |
| New mail only per poll (now) | **613–663 ms** |

The plugin now records the highest UID it has examined (`imap_mark` in `state.json`) and asks only for what is newer. If a mailbox renumbers its UIDs, the plugin detects the backwards move, re-scans the window once and re-baselines, so nothing is silently skipped. The default interval therefore drops from 30 s to 15 s — cheap polls can afford to be frequent.

Lower `pollIntervalMs` further (floor 5000) for a snappier reply, at the cost of more frequent IMAP logins.

### Diagnosing a reply that did not take effect

`scripts/check-mailbox.mjs` runs the same search and the same validator, read-only, and reports per message whether it would be accepted, the task id it resolves to, and whether its code is still valid — **without consuming the code, marking anything read, or printing a body**:

```powershell
& $node .\scripts\check-mailbox.mjs
```

## Test

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$files = Get-ChildItem .\test -Recurse -Filter *.test.js | % FullName
& $node --test --test-isolation=none @files
```

174 tests, zero runtime dependencies, built-ins only. Coverage includes the SMTP and IMAP
protocol conversations against real local TLS servers (self-signed certificate, AUTH LOGIN,
literal framing, dot-stuffing, 4xx/5xx classification), MIME encode/parse round-trips,
queue backoff and crash recovery, every reply rejection reason, the session-event mapping,
reply routing, end-to-end task → mail → reply → route, and the profile/credential text
editors. Set `DSH_YAML_MODULE` to a YAML module to additionally validate generated
documents with a real parser.

## Uninstall

```powershell
node scripts\uninstall.mjs                    # disable, keep dependency/credential/data
node scripts\uninstall.mjs --remove-credential
node scripts\uninstall.mjs --remove-credential --remove-dependency --purge-data
```

## Known limitations

- **Sending verified, reply continuation not yet.** What has been exercised: 174 automated tests, structural profile validation, a plugin boot smoke test, and **ten consecutive notifications delivered through a real QQ mailbox** (`notification.sent` recorded for each). Still unverified is the reply path — reply mail → verification → the message reaching the original session — which needs a human to answer a notification.
- **Credential resolution has a fallback path.** In practice the credentials seam returned nothing for the reference while the managed document plainly held it, so the plugin read `~/.dsh/.credentials.yaml` directly (read-only) and recorded `credential.fallback`. Writing still belongs to the seam and `set-credential.mjs`; the plugin never writes it.
- **Rejected mail stays unread in the inbox** (as in the reference), so each poll hands it back. Already-examined Message-IDs are now skipped silently, but a large backlog of stale `[DSH]`-subject mail still costs one fetch per poll (25 messages maximum). Clear the backlog to avoid it.
- **Only verified on Windows.**
- **No graphical settings surface** — configuration is via `configure.mjs`.
- Mail bodies are not encrypted end to end; only summaries are sent, by design.

## License

MIT.
