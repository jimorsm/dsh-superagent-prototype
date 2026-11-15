import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitlabKind, pollTodos } from '../src/sources/gitlab.ts'
import { noteTrigger, openedTrigger, todoTrigger, gitlabChannel, parseRefId, type GitlabNote, type GitlabTodo } from '../src/sources/gitlab-trigger.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabThreadContext } from '../src/sources/gitlab-read.ts'

vi.setConfig({ testTimeout: 30_000 })

const GITLAB = { cli: '/path/agent-glab', host: 'https://gitlab.example.com', projects: ['devops/sandbox', 'devops/widgets'], login: 'agent-bot', noreply: '7_agent-bot@users.noreply.gitlab.example.com' }
const deployment = testDeployment({ gitlab: GITLAB })
const SANDBOX = 'devops/sandbox'
const WIDGETS = 'devops/widgets'
const configOf = () => gitlabKind.schema.parse({ host: GITLAB.host, projects: [{ project: SANDBOX }, { project: WIDGETS }], cli: GITLAB.cli })

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { gitlab: { enabled: true, config: { host: GITLAB.host, projects: [{ project: SANDBOX }, { project: WIDGETS }], cli: GITLAB.cli, observeIssues: true, observeMrs: true, observeNotes: true } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}, ) , stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, gitlabKind) }
}

const todo = (id: number, overrides: Record<string, unknown> = {}): GitlabTodo => ({
  id, action_name: 'mentioned', target_type: 'Issue',
  author: { username: 'alice' },
  target: { iid: 8, project_id: 424, title: '修一下回归' },
  target_url: 'https://gitlab.example.com/devops/sandbox/-/issues/8',
  body: '@agent-bot 看一下这个', created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z',
  ...overrides,
}) as GitlabTodo

const note = (id: number, overrides: Record<string, unknown> = {}): GitlabNote => ({
  id, body: '好', system: false, author: { username: 'alice', bot: false },
  created_at: '2026-11-14T11:00:00.000Z', updated_at: '2026-11-14T11:00:00.000Z',
  ...overrides,
}) as GitlabNote

describe('gitlab trigger translation', () => {
  it('maps a mention todo to a stable trigger qualified by project, thread and address', () => {
    const trigger = todoTrigger(todo(11), SANDBOX, GITLAB)!
    expect(trigger.id).toBe(key('gitlab', 'todo-11'))
    expect(trigger.threads).toEqual([{ source: 'gitlab', id: 'devops/sandbox:issue-8' }])
    expect(trigger.actor).toEqual({ source: 'gitlab', id: 'alice' })
    expect(trigger.addressed).toBe('mention')
    expect(trigger.channel!.thread).toBe('gitlab:devops/sandbox:issue-8')
    expect(trigger.channel!.address).toMatchObject({ project: SANDBOX, kind: 'issue', iid: '8' })
    expect(trigger.meta).toMatchObject({ project: SANDBOX, kind: 'issue', iid: 8, todoId: 11 })
    // 两个项目的同号 issue 是不同线程——多项目不撞车
    const other = todoTrigger(todo(12, { target: { iid: 8, project_id: 999 } }), WIDGETS, GITLAB)!
    expect(other.threads[0]!.id).toBe('devops/widgets:issue-8')
    expect(other.threads[0]!.id).not.toBe(trigger.threads[0]!.id)
    // 非提及不 addressed；MR 目标映射 mr 线程；自己的动作/未知类型/未配置都不产生
    expect(todoTrigger(todo(13, { action_name: 'assigned' }), SANDBOX, GITLAB)!.addressed).toBeUndefined()
    expect(todoTrigger(todo(14, { target_type: 'MergeRequest', target: { iid: 3, project_id: 424 } }), SANDBOX, GITLAB)!.threads[0]!.id).toBe('devops/sandbox:mr-3')
    expect(todoTrigger(todo(15, { author: { username: 'agent-bot' } }), SANDBOX, GITLAB)).toBeUndefined()
    expect(todoTrigger(todo(16, { target_type: 'Epic' }), SANDBOX, GITLAB)).toBeUndefined()
    expect(todoTrigger(todo(17), SANDBOX, undefined)).toBeUndefined()
  })
  it('maps notes and opened issues with project-qualified ids; edits are new events', () => {
    const ref = { project: SANDBOX, kind: 'issue' as const, iid: 8 }
    const first = noteTrigger(note(21, { body: '@Agent-Bot 在吗' }), ref, GITLAB)!
    expect(first.addressed).toBe('mention')
    expect(first.meta).toMatchObject({ project: SANDBOX, noteId: 21 })
    expect(noteTrigger(note(22, { system: true }), ref, GITLAB)!.human).toBe(false)
    expect(noteTrigger(note(23, { author: { username: 'agent-bot' } }), ref, GITLAB)).toBeUndefined()
    expect(noteTrigger(note(24), ref, GITLAB)!.id).not.toBe(noteTrigger(note(24, { updated_at: '2026-11-14T12:00:00.000Z' }), ref, GITLAB)!.id)
    const opened = openedTrigger(WIDGETS, 'mr', { iid: 9, title: '标题', description: '@agent-bot 拜托', created_at: '2026-11-14T09:00:00.000Z', author: { username: 'alice' } }, GITLAB)!
    expect(opened.threads[0]!.id).toBe('devops/widgets:mr-9')
    expect(opened.addressed).toBe('mention')
  })
  it('parses project-qualified thread ref ids back', () => {
    expect(parseRefId('devops/sandbox:issue-8')).toEqual({ project: 'devops/sandbox', kind: 'issue', iid: 8 })
    expect(parseRefId('group/sub/repo:mr-31')).toEqual({ project: 'group/sub/repo', kind: 'mr', iid: 31 })
    expect(parseRefId('issue-8')).toBeUndefined()
  })
})

describe('pollTodos', () => {
  it('routes todos to their own projects, skips unconfigured ones, and moves the cursor once', async () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const glab = vi.spyOn(h.commands, 'glab')
    glab.mockImplementation(async (args: string[]) => {
      const path = String(args[1] ?? '')
      if (path === `projects/${encodeURIComponent(SANDBOX)}`) return { id: 424, path_with_namespace: SANDBOX }
      if (path === `projects/${encodeURIComponent(WIDGETS)}`) return { id: 555, path_with_namespace: WIDGETS }
      return [todo(11), todo(12, { target: { iid: 9, project_id: 555 }, target_url: 'https://gitlab.example.com/devops/widgets/-/issues/9' }),
        todo(13, { target: { iid: 1, project_id: 999 } }), todo(14, { action_name: 'assigned' })]
    })
    expect(await pollTodos(h.ctx, configOf(), new AbortController().signal)).toBe(3)
    expect(h.store.get(KV.gitlab.todos)).toBe(14)
    expect(h.receive.mock.calls.map(call => (call[0] as Trigger).threads[0]!.id).sort()).toEqual(['devops/sandbox:issue-8', 'devops/sandbox:issue-8', 'devops/widgets:issue-9'])
    expect(h.engine.candidate(key('gitlab', 'todo-11'))?.strength).toBe('explicit')
    glab.mockImplementation(async () => [todo(14, { action_name: 'assigned' })])
    expect(await pollTodos(h.ctx, configOf(), new AbortController().signal)).toBe(0)
    h.store.close()
  })
})

describe('sendGitlab', () => {
  const reply = { id: 'stable-op', channel: gitlabChannel(SANDBOX, 'issue', 8), text: '完成', kind: 'reply' as const }
  it('posts a note to the addressed project with the idempotency marker, and maps 404 to gone', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const glab = vi.spyOn(commands, 'glab')
    glab.mockResolvedValueOnce([[{ id: 1, body: '别人说的', author: { username: 'bob' }, system: false, created_at: 'x' }]])
      .mockResolvedValueOnce({})
    expect(await sendGitlab({ commands }, reply)).toBe('sent')
    expect(glab.mock.calls[1]![0]).toEqual(['api', `projects/${encodeURIComponent(SANDBOX)}/issues/8/notes`, '--method', 'POST', '-f', expect.stringContaining('<!-- dsh-superagent:stable-op -->')])
    glab.mockResolvedValueOnce([[{ id: 2, body: 'x <!-- dsh-superagent:stable-op -->', author: { username: 'agent-bot' }, system: false, created_at: 'x' }]])
    expect(await sendGitlab({ commands }, reply)).toBe('sent')
    expect(glab).toHaveBeenCalledTimes(3)  // list → POST → list（marker 命中后不再 POST）
    glab.mockRejectedValueOnce(new CliError('Not Found', 404))
    expect(await sendGitlab({ commands }, reply)).toBe('gone')
    glab.mockRejectedValueOnce(new CliError('boom'))
    await expect(sendGitlab({ commands }, reply)).rejects.toThrow('boom')
  })
  it('routes a reply to another configured project, and refuses an unconfigured one', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const glab = vi.spyOn(commands, 'glab').mockResolvedValue([])
    await sendGitlab({ commands }, { id: 'm2', channel: gitlabChannel(WIDGETS, 'mr', 3), text: '好了', kind: 'reply' })
    expect(glab.mock.calls[0]![0][1]).toBe(`projects/${encodeURIComponent(WIDGETS)}/merge_requests/3/notes`)
    await expect(sendGitlab({ commands }, { id: 'm3', channel: gitlabChannel('devops/elsewhere', 'issue', 1), text: 'x', kind: 'reply' })).rejects.toThrow('restricted to the configured projects')
  })
})

describe('gitlabThreadContext', () => {
  it('reads one page of notes from the trigger project and hands out the next page cursor while pages stay full', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const notes = Array.from({ length: 100 }, (_, i) => note(100 + i))
    const glab = vi.spyOn(commands, 'glab').mockResolvedValue([notes])
    const trigger = noteTrigger(notes[0]!, { project: WIDGETS, kind: 'issue', iid: 8 }, GITLAB)!
    const part = await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {} as never)
    expect(part.messages).toHaveLength(100)
    expect(part.next).toBe('2')
    expect(part.messages[0]).toMatchObject({ id: '100', from: 'alice', text: '好' })
    expect(String(glab.mock.calls[0]![0][1])).toContain(`projects/${encodeURIComponent(WIDGETS)}/issues/8/notes`)
    expect(gitlabThreadContext.messageId(trigger)).toBe('100')
  })
})

describe('gitlab source plugin', () => {
  it('scopes by project and observe switches, and builds admission rows per project', () => {
    const h = host()
    const config = gitlabKind.schema.parse({ host: GITLAB.host, projects: [{ project: SANDBOX }], cli: GITLAB.cli, observeNotes: true })
    expect(gitlabKind.scope!({ meta: { project: SANDBOX, kind: 'issue' } }, config)).toMatchObject({ listened: true, observed: false, row: `${SANDBOX}:issues` })
    expect(gitlabKind.scope!({ meta: { project: SANDBOX, kind: 'note' } }, config)).toMatchObject({ listened: true, observed: true, row: `${SANDBOX}:notes` })
    expect(gitlabKind.scope!({ meta: { project: 'devops/elsewhere', kind: 'issue' } }, config)).toMatchObject({ listened: false, reason: 'project_not_listed' })
    const rows = gitlabKind.policy!.rows!({ host: GITLAB.host, projects: [{ project: SANDBOX }, { project: WIDGETS }], cli: GITLAB.cli } as never)
    expect(rows.map(row => row.id)).toEqual([`${SANDBOX}:issues`, `${SANDBOX}:mrs`, `${SANDBOX}:notes`, `${WIDGETS}:issues`, `${WIDGETS}:mrs`, `${WIDGETS}:notes`])
    h.store.close()
  })
  it('finds threads by GitLab URLs with project, and exposes per-trigger environment values', () => {
    expect(gitlabKind.find!('https://gitlab.example.com/devops/sandbox/-/issues/9')).toEqual({ threads: ['gitlab:devops/sandbox:issue-9'], terms: [] })
    expect(gitlabKind.find!('https://gitlab.example.com/devops/widgets/-/merge_requests/31')).toEqual({ threads: ['gitlab:devops/widgets:mr-31'], terms: [] })
    const trigger = todoTrigger(todo(41, { target: { iid: 9, project_id: 555 }, target_url: 'https://gitlab.example.com/devops/widgets/-/issues/9' }), WIDGETS, GITLAB)
    const values = gitlabKind.environment!.values({ deployment, config: {} as never, trigger })
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITLAB_HOST: GITLAB.host, DSH_SUPERAGENT_GITLAB_PROJECT: WIDGETS, DSH_SUPERAGENT_GITLAB_ACCOUNT: 'agent-bot', DSH_SUPERAGENT_GITLAB_IID: '9' })
    expect(gitlabKind.environment!.values({ deployment, config: {} as never, trigger: undefined }).DSH_SUPERAGENT_GITLAB_PROJECT).toBe(SANDBOX)
  })
})
