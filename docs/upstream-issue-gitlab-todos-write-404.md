# Upstream issue draft — gitlab-org/gitlab

> 状态：草稿待 Boss 审。提交流向：gitlab-org/gitlab · Issues（这个是 GitLab 产品本身的 issue，不是 superagent 的）

---

**Title:** Todos API write endpoints return 404 on 17.6.5 self-managed (list endpoint works; mark_done unusable)

## Summary

On our self-managed GitLab 17.6.5 instance, every Todos API write endpoint returns `404 {"error":"404 Not Found"}` while `GET /api/v4/todos` works fine and returns the very todo IDs that then 404 on write. This makes it impossible to mark a todo as done through the API.

## Steps to reproduce

With a group access token (Developer role, `api` + `write_repository` scopes) whose user owns pending todos:

```bash
TOKEN=…
# 1. List works, todo 795 exists and is pending:
curl -sk -H "PRIVATE-TOKEN: $TOKEN" \
  'https://<instance>/api/v4/todos?state=pending&per_page=5'
# → 200, [{"id":795, ...}]

# 2. Every write/single-read variant 404s:
curl -sk -X POST -H "PRIVATE-TOKEN: $TOKEN" https://<instance>/api/v4/todos/795/mark_done
# → 404 {"error":"404 Not Found"}
curl -sk -X POST -H "PRIVATE-TOKEN: $TOKEN" https://<instance>/api/v4/todos/mark_done
# → 404 {"error":"404 Not Found"}
curl -sk -X DELETE -H "PRIVATE-TOKEN: $TOKEN" https://<instance>/api/v4/todos/795
# → 404 {"error":"404 Not Found"}

# 3. Same token, other write endpoints work fine:
curl -sk -X POST -H "PRIVATE-TOKEN: $TOKEN" \
  -F 'body=test' https://<instance>/api/v4/projects/897/issues/1/notes
# → 201 created
```

## Actual behavior

All `/api/v4/todos/*` non-list endpoints return 404 as if the routes did not exist — including `POST /todos/mark_done` (mark all), which takes no resource id and should never 404 on a missing record.

## Expected behavior

`POST /todos/:id/mark_done` and `POST /todos/mark_done` mark the authenticated user's todos done and return 200/204, as documented in https://docs.gitlab.com/api/todos/.

## Environment

- GitLab self-managed 17.6.5 (revision `a3a18341dc1`, `GET /api/v4/version`)
- Token: **group access token** (Developer, `api` scope); the token's bot user owns the todos in question
- Instance sits behind an internal reverse proxy; we cannot rule out proxy path filtering, but other POST routes under `/api/v4/` pass through

## What we could not verify yet (help wanted)

- Whether a **personal access token** (instead of a group access token) can call these endpoints on the same instance
- Whether a stock 17.6.5 (no custom proxy) reproduces it
- Whether `GET /todos/:id` is even a documented route (we got 404 there too, but it may simply not exist)

## Why it matters

Agents and bots that work from the todos queue (assignment/mention automation) need to mark todos done after processing; without it, the same pending todo is re-read forever, and GitLab's one-pending-todo-per-target behavior turns stale entries into blockers for future mentions.
