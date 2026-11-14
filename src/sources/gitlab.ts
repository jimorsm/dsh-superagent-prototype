/** GitLab source kind: todo and note polling, webhook doorbell, and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { GitlabAccountSchema } from '../deployment.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'
import { NoteSchema, openedTrigger, noteTrigger, todoTrigger, TodoSchema, refId, SOURCE, type GitlabRef } from './gitlab-trigger.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
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
  description: { zh: '智能体的 GitLab 账号；接收项目里发给它的提及与待办、已订阅 issue 与 MR 的讨论。', en: 'The agent\u2019s GitLab account; receives mentions and todos addressed to it in the project, and discussion on subscribed issues and merge requests.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: '^https?://[^/]+$', label: { zh: '实例地址', en: 'Instance URL' },
      hint: { zh: '例如 https://gitlab.example.com，不带结尾斜线。', en: 'For example https://gitlab.example.com, without a trailing slash.' } },
    { key: 'project', type: 'text', pattern: '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/name 或 group/sub/name。保存时检查智能体账号能否推送（Developer 及以上），然后重启 dsh-superagent。', en: 'Written group/name or group/sub/name. Saving checks the agent account can push (Developer or above), then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through GLAB_CONFIG_DIR.' } },
    { key: 'webhookToken', type: 'text', advanced: true, label: { zh: 'webhook 密钥', en: 'Webhook token' },
      hint: { zh: '非空时接受 POST ' + WEBHOOK_PATH + '（X-Gitlab-Token 头相同）：webhook 只当门铃，数据仍从 API 拉取。留空则不注册该路由。', en: 'When set, accepts POST ' + WEBHOOK_PATH + ' with the same X-Gitlab-Token header as a doorbell; data is still pulled through the API. Empty disables the route.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 issue', en: 'Receive new issues in the project' } },
    { key: 'observeMrs', type: 'switch', label: { zh: '接收项目里的新 MR', en: 'Receive new merge requests in the project' } },
    { key: 'observeNotes', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive notes in the project' } },
  ],
  scope: ({ meta }, config) => {
    const row = meta.kind === 'issue' ? 'issues' as const : meta.kind === 'mr' ? 'mrs' as const : 'notes' as const
    const observed = row === 'issues' ? config.observeIssues : row === 'mrs' ? config.observeMrs : config.observeNotes
    return { listened: true, observed, row }
  },
  health: [SOURCE],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const plain = /^([#!])(\d+)$/.exec(query.trim())
    if (plain) return { threads: [`${SOURCE}:${plain[1] === '!' ? 'mr' : 'issue'}-${plain[2]}`], terms: [] }
    const url = /\/([A-Za-z0-9_.\-/]+)\/-\/(issues|merge_requests)\/(\d+)/.exec(query)
    return url ? { threads: [`${SOURCE}:${url[2] === 'issues' ? 'issue' : 'mr'}-${url[3]}`], terms: [] } : { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的账号在 issue、MR 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent in an issue, merge request, or note.' },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 实例地址', en: 'GitLab instance URL' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '智能体干活的 GitLab 项目', en: 'The GitLab project the agent works on' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，除合并外的 GitLab 操作都用 glab', en: 'The agent\u2019s GitLab account; glab is signed in to it. Use glab for every GitLab operation except merging, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱', en: 'Commit email of the agent\u2019s account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 issue 或 MR 编号；工单不是从 GitLab 来的时为空', en: 'IID of the issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
    ],
    values: ({ deployment, trigger }) => ({
      DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '',
      DSH_SUPERAGENT_GITLAB_PROJECT: deployment.gitlab?.project ?? '',
      DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '',
      DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.noreply ?? '',
      DSH_SUPERAGENT_GITLAB_IID: trigger?.threads[0]?.source === SOURCE ? String(trigger.meta.iid ?? '') : '',
    }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}

/** The configured project's numeric id, resolved once per process run (projects keep their id across renames). */
async function projectId(ctx: SourceContext): Promise<number> {
  const cached = ctx.state.get(KV.gitlab.project)
  if (cached) return cached.id
  const project = ProjectSchema.parse(await ctx.commands.glab(['api', `projects/${encodeURIComponent(ctx.deployment.gitlab!.project)}`]))
  ctx.state.set(KV.gitlab.project, { id: project.id, path: project.path_with_namespace })
  return project.id
}

/** Takes in todos addressed to the agent on the configured project, oldest first, and moves the cursor past them. */
export async function pollTodos(ctx: SourceContext, signal: AbortSignal): Promise<number> {
  const id = await projectId(ctx)
  const cursor = ctx.state.get(KV.gitlab.todos) ?? 0
  const page = z.array(z.unknown()).parse(await ctx.commands.withSignal(signal).glab(['api', 'todos?state=pending&per_page=100&order_by=id&sort=asc']))
  let count = 0
  let max = cursor
  for (const item of page) {
    if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
    const parsed = TodoSchema.safeParse(item)
    if (!parsed.success) continue
    const todo = parsed.data
    if (todo.id <= cursor) continue
    max = Math.max(max, todo.id)
    if (todo.target.project_id !== id) continue
    const trigger = todoTrigger(todo, ctx.deployment.gitlab)
    if (!trigger) continue
    await ctx.receive(trigger)
    count++
    ctx.threads.describe(`${SOURCE}:${refId(trigger.meta.kind as 'issue' | 'mr', Number(trigger.meta.iid))}`,
      { url: trigger.url, ...(todo.target.title ? { label: todo.target.title } : {}) })
  }
  ctx.state.set(KV.gitlab.todos, max)
  return count
}

/** Reads the notes of one subscribed thread after its cursor; the first read starts now and replays nothing. */
async function pollNotes(ctx: SourceContext, thread: { key: string; ref: { id: string } }, signal: AbortSignal): Promise<number> {
  const ref = parseRef(thread.ref.id)
  if (!ref) return 0
  const since = ctx.state.get(KV.gitlab.notes(thread.key))
  const started = new Date().toISOString()
  if (!since) { ctx.state.set(KV.gitlab.notes(thread.key), cursorAt(started)); return 0 }
  const path = `${ref.kind === 'mr' ? 'merge_requests' : 'issues'}/${ref.iid}/notes?sort=asc&order_by=updated_at&per_page=100&updated_after=${encodeURIComponent(since)}`
  const notes = await ctx.commands.withSignal(signal).glabPages(NoteSchema, path)
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
const parseRef = (id: string): GitlabRef | undefined => {
  const match = /^(issue|mr)-(\d+)$/.exec(id)
  return match ? { kind: match[1] as 'issue' | 'mr', iid: Number(match[2]) } : undefined
}

/** Receives newly opened issues and merge requests while their observe switch is on, from the moment it is switched on. */
async function pollOpened(ctx: SourceContext, config: GitlabConfig, signal: AbortSignal): Promise<number> {
  let count = 0
  for (const kind of ['issue', 'mr'] as const) {
    if (kind === 'issue' ? !config.observeIssues : !config.observeMrs) continue
    const cursorKey = KV.gitlab.opened(kind)
    const since = ctx.state.get(cursorKey)
    const started = new Date().toISOString()
    if (!since) { ctx.state.set(cursorKey, cursorAt(started)); continue }
    const path = `${kind === 'mr' ? 'merge_requests' : 'issues'}?state=opened&order_by=created_at&sort=asc&per_page=100&created_after=${encodeURIComponent(since)}`
    const opened = await ctx.commands.withSignal(signal).glabPages(IssueOpenedSchema, path)
    for (const item of opened) {
      if (signal.aborted) throw new Error('The GitLab Source stopped during the poll')
      const trigger = openedTrigger(kind, item, ctx.deployment.gitlab)
      if (!trigger) continue
      await ctx.receive(trigger)
      count++
      ctx.threads.describe(`${SOURCE}:${refId(kind, item.iid)}`, { url: trigger.url, ...(item.title ? { label: item.title } : {}) })
    }
    ctx.state.set(cursorKey, cursorAt(started))
  }
  return count
}

async function watch(ctx: SourceContext, signal: AbortSignal, doorbell: Doorbell): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    if (!config || !config.project) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else {
      try {
        const todos = await pollTodos(ctx, signal)
        let notes = 0
        await pollEach(ctx, SOURCE, () => signal.aborted, async thread => { notes += await pollNotes(ctx, thread, signal) })
        const opened = await pollOpened(ctx, config, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${todos} todos, ${notes} notes, ${opened} opened`, at: new Date().toISOString() })
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
        if (project && config.project && !sameName(project, config.project)) { json(res, 202, { ignored: 'other_project' }); return }
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
