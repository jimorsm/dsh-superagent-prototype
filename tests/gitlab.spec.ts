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
import { apply as applyGitlab, gitlabKind, pollTodos } from '../src/sources/gitlab.ts'
import { noteTrigger, openedTrigger, todoTrigger, gitlabChannel, refId, SOURCE, type GitlabNote, type GitlabTodo } from '../src/sources/gitlab-trigger.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabThreadContext } from '../src/sources/gitlab-read.ts'

vi.setConfig({ testTimeout: 30_000 })
const GITLAB = { cli: '/path/agent-glab', host: 'https://gitlab.example.com', project: 'devops/sandbox', login: 'agent-bot', noreply: '7_agent-bot@users.noreply.gitlab.example.com' }
const deployment = testDeployment({ gitlab: GITLAB })

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { gitlab: { enabled: true, config: { host: GITLAB.host, project: GITLAB.project, cli: GITLAB.cli, observeIssues: true, observeMrs: true, observeNotes: true } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
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
  it('maps a mention todo to a stable trigger with thread, actor and address', () => {
    const trigger = todoTrigger(todo(11), GITLAB)!
    expect(trigger.id).toBe(key('gitlab', 'todo-11'))
    expect(trigger.threads).toEqual([{ source: 'gitlab', id: 'issue-8' }])
    expect(trigger.actor).toEqual({ source: 'gitlab', id: 'alice' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.channel!.thread).toBe('gitlab:issue-8')
    expect(trigger.channel!.address).toMatchObject({ kind: 'issue', iid: '8' })
    expect(trigger.meta).toMatchObject({ kind: 'issue', iid: 8, todoId: 11, action: 'mentioned' })
    // 非提及动作不 addressed；MR 目标映射到 mr 线程
    expect(todoTrigger(todo(12, { action_name: 'assigned' }), GITLAB)!.addressed).toBeUndefined()
    expect(todoTrigger(todo(13, { target_type: 'MergeRequest', target: { iid: 3, project_id: 424 } }), GITLAB)!.threads[0]!.id).toBe('mr-3')
    // 智能体自己的动作、未知目标类型、未配置 forge 都不产生 Trigger
    expect(todoTrigger(todo(14, { author: { username: 'agent-bot' } }), GITLAB)).toBeUndefined()
    expect(todoTrigger(todo(15, { target_type: 'Epic' }), GITLAB)).toBeUndefined()
    expect(todoTrigger(todo(16), undefined)).toBeUndefined()
  })
  it('maps notes and opened issues, marking system notes non-human and edits as new events', () => {
    const ref = { kind: 'issue' as const, iid: 8 }
    const first = noteTrigger(note(21, { body: '@Agent-Bot 在吗' }), ref, GITLAB)!
    expect(first.addressed).toBe('mention')
    expect(first.meta.noteId).toBe(21)
    expect(noteTrigger(note(21, { body: '没有提及' }), ref, GITLAB)!.addressed).toBeUndefined()
    expect(noteTrigger(note(22, { system: true }), ref, GITLAB)!.human).toBe(false)
    expect(noteTrigger(note(23, { author: { username: 'agent-bot' } }), ref, GITLAB)).toBeUndefined()
    // 编辑过 = 新事件（id 带 updated_at）
    expect(noteTrigger(note(24), ref, GITLAB)!.id).not.toBe(noteTrigger(note(24, { updated_at: '2026-11-14T12:00:00.000Z' }), ref, GITLAB)!.id)
    const opened = openedTrigger('issue', { iid: 9, title: '标题', description: '@agent-bot 拜托', created_at: '2026-11-14T09:00:00.000Z', author: { username: 'alice' } }, GITLAB)!
    expect(opened.threads[0]!.id).toBe('issue-9')
    expect(opened.addressed).toBe('mention')
  })
})

describe('pollTodos', () => {
  it('takes in new todos of the configured project once and moves the cursor past them', async () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const glab = vi.spyOn(h.commands, 'glab')
    glab.mockImplementation(async (args: string[]) => args[1]?.startsWith('projects/')
      ? { id: 424, path_with_namespace: 'devops/sandbox' }
      : [todo(11), todo(12, { target: { iid: 9, project_id: 999 } }), todo(13, { action_name: 'assigned' })])
    expect(await pollTodos(h.ctx, new AbortController().signal)).toBe(2)
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(h.store.get(KV.gitlab.todos)).toBe(13)
    // 名单里的人 @ 智能体 → explicit 候选
    expect(h.engine.candidate(key('gitlab', 'todo-11'))?.strength).toBe('explicit')
    // 重放同一页：旧游标内的不产生，重复的接受为 duplicate
    glab.mockImplementation(async () => [todo(12, { target: { iid: 9, project_id: 999 } }), todo(13, { action_name: 'assigned' })])
    expect(await pollTodos(h.ctx, new AbortController().signal)).toBe(0)
    expect(h.store.get(KV.gitlab.todos)).toBe(13)
    h.store.close()
  })
})

describe('sendGitlab', () => {
  const reply = { id: 'stable-op', channel: gitlabChannel('issue', 8), text: '完成', kind: 'reply' as const }
  it('posts a note with the idempotency marker, skips when the marker is already there, and maps 404 to gone', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const glabPages = vi.spyOn(commands, 'glabPages').mockResolvedValue([])
    const glabApi = vi.spyOn(commands, 'glabApi').mockResolvedValue('{}')
    expect(await sendGitlab({ commands }, reply)).toBe('sent')
    const call = glabApi.mock.calls[0]!
    expect(call.slice(1, 5)).toEqual(['issues/8/notes', '--method', 'POST', '-f'])
    expect(String(call[5])).toBe('body=完成\n\n<!-- dsh-superagent:stable-op -->')
    glabPages.mockResolvedValue([note(31, { author: { username: 'agent-bot' }, body: 'x <!-- dsh-superagent:stable-op -->' })])
    expect(await sendGitlab({ commands }, reply)).toBe('sent')
    expect(glabApi).toHaveBeenCalledTimes(1)
    glabPages.mockRejectedValue(new CliError('Not Found', 404))
    expect(await sendGitlab({ commands }, reply)).toBe('gone')
    glabPages.mockRejectedValue(new CliError('boom'))
    await expect(sendGitlab({ commands }, reply)).rejects.toThrow('boom')
  })
})

describe('gitlabThreadContext', () => {
  it('reads one page of notes and hands out the next page cursor while pages stay full', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const notes = Array.from({ length: 100 }, (_, i) => note(100 + i))
    vi.spyOn(commands, 'glabPages').mockResolvedValue(notes)
    const trigger = noteTrigger(notes[0]!, { kind: 'issue', iid: 8 }, GITLAB)!
    const part = await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {} as never)
    expect(part.messages).toHaveLength(100)
    expect(part.next).toBe('2')
    expect(part.messages[0]).toMatchObject({ id: '100', from: 'alice', text: '好' })
    expect(gitlabThreadContext.messageId(trigger)).toBe('100')
    vi.spyOn(commands, 'glabPages').mockResolvedValue([notes[0]!])
    expect((await gitlabThreadContext.read(commands, trigger, 'thread', '2', {} as never)).next).toBeUndefined()
  })
})

describe('gitlab source plugin', () => {
  it('registers its kind and exposes its configuration, policy and environment', () => {
    const h = host()
    const scope = gitlabKind.scope!({ meta: { kind: 'mr' } }, { observeMrs: false } as never)
    expect(scope).toMatchObject({ listened: true, observed: false, row: 'mrs' })
    const values = gitlabKind.environment!.values({ deployment, config: {} as never, trigger: todoTrigger(todo(41), GITLAB) })
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITLAB_HOST: GITLAB.host, DSH_SUPERAGENT_GITLAB_PROJECT: GITLAB.project,
      DSH_SUPERAGENT_GITLAB_ACCOUNT: 'agent-bot', DSH_SUPERAGENT_GITLAB_IID: '8' })
    h.store.close()
  })
  it('finds threads by #issue, !MR and GitLab URLs', () => {
    expect(gitlabKind.find!('#12')).toEqual({ threads: ['gitlab:issue-12'], terms: [] })
    expect(gitlabKind.find!('!3')).toEqual({ threads: ['gitlab:mr-3'], terms: [] })
    expect(gitlabKind.find!('https://gitlab.example.com/devops/sandbox/-/issues/9')).toEqual({ threads: ['gitlab:issue-9'], terms: [] })
    expect(gitlabKind.find!('别的')).toEqual({ threads: [], terms: [] })
  })
})
