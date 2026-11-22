# Upstream issue draft — deepseek-ai/dsh-superagent-prototype

> 状态：草稿待 Boss 审。提交流向：GitHub deepseek-ai/dsh-superagent-prototype · Issues

---

**Title:** Notification-based sources silently drop re-mentions on the same thread (one pending todo/notification per user+target)

## Summary

Sources that poll the forge's notification queue (GitHub notifications, GitLab todos) with an id-only cursor miss work requests when the user re-mentions the agent on an issue/MR that already has an unread notification for the bot. Both GitHub and GitLab coalesce: **one pending notification/todo per user per target**. A new @mention on the same target does not create a new queue entry — the existing one stays (and in GitLab's case the id never changes). An id-cursor poller has already advanced past that entry, so the re-mention is invisible and the agent stays silent.

## Observed behavior (GitLab 17.6, dsh-superagent gitlab source)

1. Bot had a pending todo (id 795) on sandbox issue #1, created by an earlier mention.
2. A human posted **two new comments** mentioning the bot on the same issue (note ids 12978, 12979).
3. GET /todos?state=pending still showed exactly one entry for that issue — id 795, unchanged. No new todo was created.
4. The source's cursor was already at 795, the received counter never moved; Router never saw the requests.
5. Posting the same mention on a **fresh issue** (#2) produced a new todo immediately and the agent picked it up in under 60s (mention to MR opened).

So the pipeline works end to end — except when the user asks twice on the same thread, which in practice is the *most common* interaction pattern ("thanks, now also do X", "you misunderstood, try again").

## Why this matters

- Users experience it as "the agent randomly ignores me".
- The failure is silent on both sides: no new queue entry on the forge, no error in the source — the health board stays green.
- The natural workaround ("ask the user to open a new issue every time") contradicts how people actually use issue threads.

## Root cause shape

Id-cursor polling assumes the queue is append-only. Notification queues are not: they are upsert-by-(user, target). Any source whose cursor is "max id seen" inherits this blind spot, on GitLab (todos) and very likely on GitHub (notifications are also per-thread coalesced; a new comment on an already-unread thread only bumps the existing notification's updated_at).

## Suggested directions (not mutually exclusive)

1. **Advance the cursor by updated_at, not by id** — treat a bumped updated_at on a known todo/notification as a new event (re-emit a trigger keyed by id+updated_at, letting the trigger store dedupe true duplicates).
2. **Mark todos done after ingest** — after a trigger is accepted (or decided), call POST /todos/:id/mark_done so the next mention on that target creates a fresh todo. (Caveat found during testing: single-todo endpoints like GET/POST /todos/:id returned 404 on our GitLab 17.6 instance even though the todo appears in the list — needs verification whether that's instance config, token type (group access token), or an upstream GitLab quirk.)
3. **Complement notifications with a comments/notes watcher** on already-known threads: the source already tracks threads with live tickets; polling notes?updated_after=cursor on those threads catches re-mentions regardless of todo state. (Our GitLab source does this for subscribed threads, but threads without a live ticket are not polled — exactly the case that bit us.)
4. At minimum, **document the limitation** and recommend one of the above as the supported pattern.

## Environment

- dsh-superagent-prototype fork, branch gitlab-source (multi-project GitLab source, commit 54cbceb)
- GitLab self-managed 17.6.5, group access token (Developer) as bot identity
- DSH 0.2.2-rc.1, single-node deployment

---

## 中文要点（供内部评审）

- **现象**：同一 issue 已有未读 todo 时，再 @ 机器人不产生新 todo；id 游标轮询永远看不到，表现为「第二次开始就被无视」。
- **证据**：todo 795 钉在 issue #1 上；12978/12979 两条真人 @ 评论均未产生新 todo；换新 issue #2 立即产生新 todo 并 60 秒内接单。
- **GitHub 大概率同病**：notifications 同样按 thread 合并，updated_at 会被撞动但 id 不变。
- **建议**：updated_at 游标 / 接单后 mark_done / 已知线程 notes 轮询补位；最低限度写进文档。
- **附带发现**：GitLab 17.6 单条 todo 端点（GET/POST /todos/:id）404，但列表接口可见该 todo——token 类型还是实例配置问题待查。
