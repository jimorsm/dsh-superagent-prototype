/** GitLab source kind: multi-project todo and note polling, webhook doorbell, and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { GitlabAccountSchema } from '../deployment.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'
import { NoteSchema, openedTrigger, noteTrigger, todoTrigger, TodoSchema, parseRefId, refId, SOURCE } from './gitlab-trigger.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { observeMr, readMr } from './gitlab-mr.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { sameName } from '../infra/text.ts'

export const GitlabConfigSchema = GitlabAccountSchema.extend({
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  webhookToken: z.string().trim().default(''),
  observeIssues: z.boolean().default(false),
  observeMrs: z.boolean().default(false),
  observeNotes: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
/** The configured project paths, deduplicated. */
const projectsOf = (config: GitlabConfig): string[] => [...new Set(config.projects.map(entry => entry.project))]

const ProjectSchema = z.looseObject({ id: z.number().int(), path_with_namespace: z.string() })
const IssueOpenedSchema = z.looseObject({
  iid: z.number().int(), title: z.string().nullish(), description: z.string().nullish(), created_at: z.string(),
  author: z.looseObject({ username: z.string() }).nullish(), web_url: z.string().nullish(),
})

const WEBHOOK_PATH = '/superagent/gitlab-webhook'
/** Hashes compared so the webhook token check never leaks its length through timing. */
const tokenMatches = (given: unknown, expected: string): boolean => {
  if (typeof given !== 'string' || !given) return false
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest())
}
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const readBody = (req: IncomingMessage, cap = 1 << 20): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > cap) { reject(new Error('webhook payload too large')); req.destroy(); return }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

/** One ring wakes the sleeping poll cycle; data still comes from the API, never from the payload. */
interface Doorbell { ring(): void; wait(ms: number, signal: AbortSignal): Promise<void> }
function newDoorbell(): Doorbell {
  let listeners: (() => void)[] = []
  return {
    ring: () => { const woken = listeners; listeners = []; for (const wake of woken) wake() },
    wait: (ms, signal) => Promise.race([pause(ms, signal), new Promise<void>(resolve => listeners.push(resolve))]),
  }
}

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收这些项目里发给它的提及与待办、已订阅 issue 与 MR 的讨论。', en: 'The agent\u2019s GitLab account; receives mentions and todos addressed to it in these projects, and discussion on subscribed issues and merge requests.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: '^https?://[^/]+$', label: { zh: '实例地址', en: 'Instance URL' },
      hint: { zh: '例如 https://gitlab.example.com，不带结尾斜线。', en: 'For example https://gitlab.example.com, without a trailing slash.' } },
    { key: 'projects', type: 'rows', label: { zh: '监听的项目', en: 'Projects' }, columns: [
      { key: 'project', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+' },
    ], hint: { zh: '写作 group/name 或 group/sub/name，可以多个。保存时逐个检查智能体账号能否推送（Developer 及以上），然后重启 dsh-superagent。', en: 'Written group/name or group/sub/name; several are allowed. Saving checks the agent account can push to each (Developer or above), then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through GLAB_CONFIG_DIR.' } },
    { key: 'webhookToken', type: 'text', advanced: true, label: { zh: 'webhook 密钥', en: 'Webhook token' },
      hint: { zh: '非空时接受 POST ' + WEBHOOK_PATH + '（X-Gitlab-Token 头相同）：webhook 只当门铃，数据仍从 API 拉取。留空则不注册该路由。', en: 'When set, accepts POST ' + WEBHOOK_PATH + ' with the same X-Gitlab-Token header as a doorbell; data is still pulled through the API. Empty disables the route.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收这些项目里的新 issue', en: 'Receive new issues in the projects' } },
    { key: 'observeMrs', type: 'switch', label: { zh: '接收这些项目里的新 MR', en: 'Receive new merge requests in the projects' } },
    { key: 'observeNotes', type: 'switch', label: { zh: '接收这些项目里的评论', en: 'Receive notes in the projects' } },
  ],
  scope: ({ meta }, config) => {
    const project = String(meta.project ?? '')
    if (!projectsOf(config).some(listed => sameName(listed, project))) {
      return { listened: false, reason: 'project_not_listed' }
    }
    const row = `${project}:${meta.kind === 'issue' ? 'issues' : meta.kind === 'mr' ? 'mrs' : 'notes'}`
    const observed = meta.kind === 'issue' ? config.observeIssues : meta.kind === 'mr' ? config.observeMrs : config.observeNotes
    return { listened: true, observed, row }
  },
  health: [SOURCE],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const plain = /^([#!])(\d+)$/.exec(query.trim())
    if (plain) {
      const kind = plain[1] === '!' ? 'mr' : 'issue'
      return { threads: [], terms: [], // 不带项目前缀无法定位到唯一线程；给搜索词兜底
      }
    }
    const url = /^https?:\/\/[^/]+\/([A-Za-z0-9_.\-/]+?)\/-\/(issues|merge_requests)\/(\d+)/.exec(query.trim())
    return url ? { threads: [`${SOURCE}:${url[1]}:${url[2] === 'issues' ? 'issue' : 'mr'}-${url[3]}`], terms: [] } : { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的账号在 issue、MR 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent in an issue, merge request, or note.' },
    rows: stored => {
      const config = GitlabConfigSchema.parse(stored)
      return projectsOf(config).flatMap(project => (['issues', 'mrs', 'notes'] as const).map(scopeName => {
        const observed = scopeName === 'issues' ? config.observeIssues : scopeName === 'mrs' ? config.observeMrs : config.observeNotes
        const label = { issues: 'issue', mrs: 'MR', notes: '评论' }[scopeName]
        return { id: `${project}:${scopeName}`, label: `${project} · ${label}`,
          note: observed ? { zh: '接收全部', en: 'All received' } : { zh: '仅 @', en: '@ only' },
          cells: { listedUnaddressed: observed, unlistedAddressed: true, unlistedUnaddressed: observed } }
      }))
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 实例地址', en: 'GitLab instance URL' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '工单来源的 GitLab 项目；不是从 GitLab 来的工单为空', en: 'The GitLab project the ticket came from; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，除合并外的 GitLab 操作都用 glab', en: 'The agent\u2019s GitLab account; glab is signed in to it. Use glab for every GitLab operation except merging, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱', en: 'Commit email of the agent\u2019s account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 issue 或 MR 编号；工单不是从 GitLab 来的时为空', en: 'IID of the issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
    ],
    values: ({ deployment, trigger }) => ({
      DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '',
      DSH_SUPERAGENT_GITLAB_PROJECT: trigger?.source === SOURCE ? String(trigger.meta.project ?? '') : (deployment.gitlab?.projects[0] ?? ''),
      DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '',
      DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.noreply ?? '',
      DSH_SUPERAGENT_GITLAB_IID: trigger?.threads[0]?.source === SOURCE ? String(trigger.meta.iid ?? '') : '',
    }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}

/** The configured projects' numeric ids by path, resolved once and cached (projects keep their id across renames). */
async function projectIds(ctx: SourceContext, projects: string[]): Promise<Map<string, number>> {
  const cached = ctx.state.get(KV.gitlab.projects) ?? {}
  const map = new Map<string, number>()
  for (const project of projects) {
    const hit = cached[project]
    if (hit) { map.set(project, hit); continue }
    const resolved = ProjectSchema.parse(await ctx.commands.glab(['api', `projects/${encodeURIComponent(project)}`]))
    cached[project] = resolved.id
    map.set(project, resolved.id)
  }
  ctx.state.set(KV.gitlab.projects, cached)
  return map
}

/** A Thread that still holds a pending todo addressed to the agent. */
export interface TodoWatch { key: string; ref: { id: string } }

/** Takes in todos addressed to the agent on the configured projects, oldest first, moves the cursor past them, and
 * lists every Thread still holding a pending todo: GitLab creates at most one pending todo per user+target, so a
 * re-mention on such a target produces no new todo and its updated_at never moves — the watch loop polls the notes
 * of these Threads directly to hear re-mentions. */
export async function pollTodos(ctx: SourceContext, config: GitlabConfig, signal: AbortSignal): Promise<{ count: number; threads: TodoWatch[] }> {
  const ids = await projectIds(ctx, projectsOf(config))
  const cursor = ctx.state.get(KV.gitlab.todos) ?? 0
  const page = z.array(z.unknown()).parse(await ctx.commands.withSignal(signal).glab(['api', 'todos?state=pending&per_page=100&order_by=id&sort=asc']))
  const idByProjects = new Map([...ids.entries()].map(([path, id]) => [id, path]))
  let count = 0
  let max = cursor
  const threads = new Map<string, TodoWatch>()
  for (const item of page) {
    if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
    const parsed = TodoSchema.safeParse(item)
    if (!parsed.success) continue
    const todo = parsed.data
    const project = idByProjects.get(todo.target.project_id)
    if (!project) continue
    const kind = todo.target_type === 'MergeRequest' ? 'mr' as const : todo.target_type === 'Issue' ? 'issue' as const : undefined
    if (!kind) continue
    const id = refId(project, kind, todo.target.iid)
    threads.set(id, { key: `${SOURCE}:${id}`, ref: { id } })
    if (todo.id <= cursor) continue
    max = Math.max(max, todo.id)
    const trigger = todoTrigger(todo, project, ctx.deployment.gitlab)
    if (!trigger) continue
    await ctx.receive(trigger)
    count++
    ctx.threads.describe(`${SOURCE}:${id}`,
      { url: trigger.url, ...(todo.target.title ? { label: todo.target.title } : {}), facts: { project: { label: { zh: '项目', en: 'Project' }, value: project } } })
  }
  ctx.state.set(KV.gitlab.todos, max)
  return { count, threads: [...threads.values()] }
}

/** Reads the notes of one subscribed or todo-watched thread after its cursor; the first read starts now and replays nothing. */
export async function pollNotes(ctx: SourceContext, thread: { key: string; ref: { id: string } }, signal: AbortSignal): Promise<number> {
  const ref = parseRefId(thread.ref.id)
  if (!ref) return 0
  const since = ctx.state.get(KV.gitlab.notes(thread.key))
  const started = new Date().toISOString()
  if (!since) { ctx.state.set(KV.gitlab.notes(thread.key), cursorAt(started)); return 0 }
  const path = `${ref.kind === 'mr' ? 'merge_requests' : 'issues'}/${ref.iid}/notes?sort=asc&order_by=updated_at&per_page=100&updated_after=${encodeURIComponent(since)}`
  const notes = await ctx.commands.withSignal(signal).glabPagesOn(ref.project, NoteSchema, path)
  let count = 0
  for (const note of notes) {
    if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
    const trigger = noteTrigger(note, ref, ctx.deployment.gitlab)
    if (!trigger) continue
    await ctx.receive(trigger)
    count++
  }
  ctx.state.set(KV.gitlab.notes(thread.key), cursorAt(started))
  return count
}

/** Receives newly opened issues and merge requests of each configured project while their observe switch is on. */
async function pollOpened(ctx: SourceContext, config: GitlabConfig, signal: AbortSignal): Promise<number> {
  let count = 0
  for (const project of projectsOf(config)) {
    for (const kind of ['issue', 'mr'] as const) {
      if (kind === 'issue' ? !config.observeIssues : !config.observeMrs) continue
      const cursorKey = KV.gitlab.opened(project, kind)
      const since = ctx.state.get(cursorKey)
      const started = new Date().toISOString()
      if (!since) { ctx.state.set(cursorKey, cursorAt(started)); continue }
      const path = `${kind === 'mr' ? 'merge_requests' : 'issues'}?state=opened&order_by=created_at&sort=asc&per_page=100&created_after=${encodeURIComponent(since)}`
      const opened = await ctx.commands.withSignal(signal).glabPagesOn(project, IssueOpenedSchema, path)
      for (const item of opened) {
        if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
        const trigger = openedTrigger(project, kind, item, ctx.deployment.gitlab)
        if (!trigger) continue
        await ctx.receive(trigger)
        count++
        ctx.threads.describe(`${SOURCE}:${refId(project, kind, item.iid)}`, { url: trigger.url, ...(item.title ? { label: item.title } : {}), facts: { project: { label: { zh: '项目', en: 'Project' }, value: project } } })
      }
      ctx.state.set(cursorKey, cursorAt(started))
    }
  }
  return count
}

/** Observes the MRs of each configured project for ticket binding and lifecycle: the first round binds the open
 * ones (observation is not intake, so nothing is replayed as a Trigger), later rounds reconcile what changed. */
async function pollMrs(ctx: SourceContext, config: GitlabConfig, signal: AbortSignal): Promise<number> {
  let count = 0
  for (const project of projectsOf(config)) {
    if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
    const cursor = ctx.state.get(KV.gitlab.mrsUpdated(project))
    const started = new Date().toISOString()
    const path = cursor
      ? `merge_requests?updated_after=${encodeURIComponent(cursor)}&order_by=updated_at&sort=asc&per_page=100&state=all`
      : 'merge_requests?state=opened&per_page=100'
    const items = await ctx.commands.withSignal(signal).glabPagesOn(project, z.looseObject({ iid: z.number().int() }), path)
    for (const item of items) {
      if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
      await observeMr(ctx, project, await readMr(ctx, project, item.iid, signal))
      count++
    }
    ctx.state.set(KV.gitlab.mrsUpdated(project), cursorAt(started))
  }
  return count
}

async function watch(ctx: SourceContext, signal: AbortSignal, doorbell: Doorbell): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    if (!config || !projectsOf(config).length) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else {
      try {
        const { count: todos, threads: todoWatches } = await pollTodos(ctx, config, signal)
        let notes = 0
        await pollEach(ctx, SOURCE, () => signal.aborted, async thread => { notes += await pollNotes(ctx, thread, signal) })
        const subscribed = new Set(ctx.threads.subscribed(SOURCE).map(thread => thread.key))
        for (const thread of todoWatches) { if (!subscribed.has(thread.key)) notes += await pollNotes(ctx, thread, signal) }
        const opened = await pollOpened(ctx, config, signal)
        const mrs = await pollMrs(ctx, config, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${todos} todos, ${notes} notes, ${opened} opened, ${mrs} mrs`, at: new Date().toISOString() })
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        if (failures >= (config.failuresBeforeError || 3)) {
          ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await doorbell.wait((config?.pollSeconds ?? 60) * 1000, signal)
  }
}

/** Registers the webhook doorbell route when the host exposes a web server; polling alone keeps the Source working without it. */
function registerWebhook(ctx: Context, source: SourceContext, doorbell: Doorbell): void {
  const webServer = (ctx as { get?: (name: string) => unknown }).get?.('webServer') as
    { register?(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): unknown } | undefined
  if (!webServer?.register) return
  webServer.register({
    kind: 'prefix', path: WEBHOOK_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        if (req.method !== 'POST') { json(res, 405, { error: 'POST required' }); return }
        const config = source.config<GitlabConfig>(SOURCE)
        if (!config?.webhookToken) { json(res, 503, { error: 'The GitLab webhook is not configured' }); return }
        if (!tokenMatches(req.headers['x-gitlab-token'], config.webhookToken)) { json(res, 401, { error: 'Bad webhook token' }); return }
        const body = JSON.parse(await readBody(req)) as { project?: { path_with_namespace?: string } }
        // The payload is only a doorbell: reject nothing, trust nothing, pull the data through the API.
        const project = body?.project?.path_with_namespace
        if (project && !projectsOf(config).some(listed => sameName(listed, project))) { json(res, 202, { ignored: 'other_project' }); return }
        doorbell.ring()
        json(res, 204, {})
      } catch (error) {
        json(res, 400, { error: String(error) })
      }
    },
  })
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const doorbell = newDoorbell()
    registerWebhook(ctx, source, doorbell)
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal, doorbell)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
