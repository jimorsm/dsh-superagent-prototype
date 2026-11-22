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
import { gitlabKind, pollNotes, pollStream, pollTodos } from '../src/sources/gitlab.ts'
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
    const first = await pollTodos(h.ctx, configOf(), new AbortController().signal)
    expect(first.count).toBe(3)
    expect(first.threads.map(thread => thread.key).sort()).toEqual(['gitlab:devops/sandbox:issue-8', 'gitlab:devops/widgets:issue-9'])
    expect(h.store.get(KV.gitlab.todos)).toBe(14)
    expect(h.receive.mock.calls.map(call => (call[0] as Trigger).threads[0]!.id).sort()).toEqual(['devops/sandbox:issue-8', 'devops/sandbox:issue-8', 'devops/widgets:issue-9'])
    expect(h.engine.candidate(key('gitlab', 'todo-11'))?.strength).toBe('explicit')
    glab.mockImplementation(async () => [todo(14, { action_name: 'assigned' })])
    expect((await pollTodos(h.ctx, configOf(), new AbortController().signal)).count).toBe(0)
    h.store.close()
  })
})

describe('pollStream 流式摄入', () => {
  const item = (iid: number, overrides: Record<string, unknown> = {}) => ({
    iid, title: `条目 ${iid}`, description: '', created_at: '2026-11-22T08:00:00Z', updated_at: '2026-11-22T08:00:00Z',
    author: { username: 'alice' }, web_url: `https://gitlab.example.com/devops/sandbox/-/issues/${iid}`, ...overrides,
  })
  const streamHost = () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const run = vi.spyOn(h.commands, 'run')
    const setRoutes = (responses: Record<string, string>) => run.mockImplementation(async (_cli: string, args: string[]) => {
      const path = String(args[1] ?? '')
      for (const [match, value] of Object.entries(responses)) if (path.includes(match)) return value
      return ''
    })
    return { ...h, run, setRoutes }
  }
  it('首轮只初始化游标不回放；之后新开的 issue（带 @提及）成为触发器，其评论也被读到', async () => {
    const h = streamHost()
    const signal = new AbortController().signal
    const cfg = configOf()
    h.setRoutes({ 'issues?': '' })
    expect(await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')).toEqual({ opened: 0, notes: 0, mrs: 0 })
    h.setRoutes({
      'issues?': JSON.stringify(item(8, { description: '@agent-bot 看看', created_at: '2026-11-22T08:30:00Z' })),
      'issues/8/notes': JSON.stringify({ id: 60, body: '@agent-bot 补充一点', author: { username: 'alice' }, system: false, created_at: '2026-11-22T08:31:00Z' }),
    })
    const round = await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')
    expect(round.opened).toBe(1)
    expect(round.notes).toBe(1)  // 新 issue 的评论从流游标读起，@提及被听到
    expect(h.receive.mock.calls.map(c => (c[0] as Trigger).addressed)).toEqual(['mention', 'mention'])
    h.store.close()
  })
  it('未订阅线程只收 @提及，订阅线程全收', async () => {
    const h = streamHost()
    const signal = new AbortController().signal
    const cfg = configOf()
    h.setRoutes({ 'issues?': '' })
    await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')  // 初始化
    const notes = [
      { id: 70, body: '随便聊聊', author: { username: 'bob' }, system: false, created_at: '2026-11-22T09:00:00Z' },
      { id: 71, body: '@agent-bot 这个呢', author: { username: 'bob' }, system: false, created_at: '2026-11-22T09:01:00Z' },
    ]
    h.setRoutes({ 'issues?': JSON.stringify(item(9, { created_at: '2026-11-22T07:00:00Z' })), 'issues/9/notes': notes.map(n => JSON.stringify(n)).join('\n') })
    const round = await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')
    expect(round.opened).toBe(0)  // created_at 在游标前，不是新开
    expect(round.notes).toBe(1)   // 只有 @提及那条
    expect((h.receive.mock.calls[0]![0] as Trigger).meta.noteId).toBe(71)
    h.store.close()
  })
})

describe('autopilot 标签派单', () => {
  const labeledItem = (iid: number, labels: string[]) => ({
    iid, title: `需求 ${iid}`, description: '把 README 改一下', created_at: '2026-11-22T08:00:00Z', updated_at: '2026-11-22T08:00:00Z',
    author: { username: 'alice' }, web_url: `https://gitlab.example.com/devops/sandbox/-/issues/${iid}`, labels,
  })
  const autoHost = () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const run = vi.spyOn(h.commands, 'run')
    const setRoutes = (responses: Record<string, string>) => run.mockImplementation(async (_cli: string, args: string[]) => {
      const path = String(args[1] ?? '')
      for (const [match, value] of Object.entries(responses)) if (path.includes(match)) return value
      return ''
    })
    return { ...h, run, setRoutes }
  }
  const cfgWithLabel = () => gitlabKind.schema.parse({ host: GITLAB.host, projects: [{ project: SANDBOX }], cli: GITLAB.cli, autopilotLabel: 'autopilot' })

  it('贴了标签的 issue 派单：贴标签的人是发起者，一次性不重复', async () => {
    const h = autoHost()
    const signal = new AbortController().signal
    const cfg = cfgWithLabel()
    h.setRoutes({ '/issues?': '' })
    await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')  // 初始化游标
    h.setRoutes({
      '/issues?': JSON.stringify(labeledItem(8, ['autopilot'])),
      '/issues/8/resource_label_events': JSON.stringify({ action: 'add', created_at: '2026-11-22T08:05:00Z', label: { name: 'autopilot' }, user: { username: 'bob' } }),
      '/issues/8/notes': '',
    })
    const round = await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')
    expect(round.opened).toBe(1)
    const trigger = h.receive.mock.calls.at(-1)![0] as Trigger
    expect(trigger.addressed).toBe('direct')
    expect(trigger.actor).toEqual({ source: 'gitlab', id: 'bob' })  // 贴标签的人是发起者
    expect(trigger.meta).toMatchObject({ autopilot: 'autopilot', labeledBy: 'bob', iid: 8 })
    expect(trigger.text).toContain('标签派单')
    // 下一轮同 id 已存在，不再读 label events 也不重复派单
    const callsBefore = h.run.mock.calls.length
    const again = await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')
    expect(again.opened).toBe(0)
    expect(h.run.mock.calls.length).toBeLessThanOrEqual(callsBefore + 2)  // 只读列表+notes，不碰 label events
    h.store.close()
  })
  it('没有标签、标签名为空、或查不到贴标签的人，都不派单', async () => {
    const h = autoHost()
    const signal = new AbortController().signal
    const cfg = cfgWithLabel()
    h.setRoutes({ '/issues?': '' })
    await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')
    // 无标签
    h.setRoutes({ '/issues?': JSON.stringify(labeledItem(8, ['other'])), '/issues/8/notes': '' })
    expect((await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')).opened).toBe(0)
    // 有标签但查不到谁贴的 → fail closed
    h.setRoutes({ '/issues?': JSON.stringify(labeledItem(9, ['autopilot'])), '/issues/9/resource_label_events': '', '/issues/9/notes': '' })
    expect((await pollStream(h.ctx, cfg, signal, SANDBOX, 'issues')).opened).toBe(0)
    // 标签名留空 = 功能关闭
    const off = configOf()
    h.setRoutes({ '/issues?': JSON.stringify(labeledItem(10, ['autopilot'])), '/issues/10/notes': '' })
    expect((await pollStream(h.ctx, off, signal, SANDBOX, 'issues')).opened).toBe(0)
    h.store.close()
  })
})

describe('todo-watched notes', () => {
  it('hears a re-mention on a thread whose pending todo was already consumed', async () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    h.store.set(KV.gitlab.todos, 15)  // todo 11 已被游标越过：模拟「同目标的唯一 pending todo 早已被接单」
    const glab = vi.spyOn(h.commands, 'glab')
    glab.mockImplementation(async (args: string[]) => {
      const path = String(args[1] ?? '')
      if (path === `projects/${encodeURIComponent(SANDBOX)}`) return { id: 424, path_with_namespace: SANDBOX }
      if (path === `projects/${encodeURIComponent(WIDGETS)}`) return { id: 555, path_with_namespace: WIDGETS }
      return [todo(11)]
    })
    const first = await pollTodos(h.ctx, configOf(), new AbortController().signal)
    expect(first.count).toBe(0)  // 重复 @ 不产生新 todo——这正是盲区场景
    expect(first.threads.map(thread => thread.key)).toEqual(['gitlab:devops/sandbox:issue-8'])
    const signal = new AbortController().signal
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue('[]')
    expect(await pollNotes(h.ctx, first.threads[0]!, signal)).toBe(0)  // 首次只初始化游标，不回放老评论
    run.mockResolvedValue(JSON.stringify({ id: 50, body: '@agent-bot 再来一次', author: { username: 'alice' }, system: false, created_at: '2026-11-22T05:00:00Z' }))
    expect(await pollNotes(h.ctx, first.threads[0]!, signal)).toBe(1)
    const trigger = h.receive.mock.calls.at(-1)![0] as Trigger
    expect(trigger.addressed).toBe('mention')
    expect(trigger.meta.noteId).toBe(50)
    h.store.close()
  })
})

describe('sendGitlab', () => {
  const reply = { id: 'stable-op', channel: gitlabChannel(SANDBOX, 'issue', 8), text: '完成', kind: 'reply' as const }
  it('posts a note to the addressed project with the idempotency marker, and maps 404 to gone', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('')
    const glab = vi.spyOn(commands, 'glab').mockResolvedValue({})
    expect(await sendGitlab({ commands }, reply)).toBe('sent')
    // 发帖走 glab（项目前缀 + 幂等 marker），列表走 run（原始文本拼页）
    expect(glab.mock.calls[0]![0][1]).toBe(`projects/${encodeURIComponent(SANDBOX)}/issues/8/notes`)
    expect(String(glab.mock.calls[0]![0].at(-1))).toContain('<!-- dsh-superagent:stable-op -->')
    run.mockResolvedValue(JSON.stringify(note(2, { author: { username: 'agent-bot' }, body: 'x <!-- dsh-superagent:stable-op -->' })))
    expect(await sendGitlab({ commands }, reply)).toBe('sent')
    expect(glab).toHaveBeenCalledTimes(1)  // marker 命中后不再 POST
    run.mockRejectedValueOnce(new CliError('Not Found', 404))
    expect(await sendGitlab({ commands }, reply)).toBe('gone')
    run.mockRejectedValueOnce(new CliError('boom'))
    await expect(sendGitlab({ commands }, reply)).rejects.toThrow('boom')
  })
  it('routes a reply to another configured project, and refuses an unconfigured one', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('')
    const glab = vi.spyOn(commands, 'glab').mockResolvedValue({})
    await sendGitlab({ commands }, { id: 'm2', channel: gitlabChannel(WIDGETS, 'mr', 3), text: '好了', kind: 'reply' })
    expect(glab.mock.calls[0]![0][1]).toBe(`projects/${encodeURIComponent(WIDGETS)}/merge_requests/3/notes`)
    await expect(sendGitlab({ commands }, { id: 'm3', channel: gitlabChannel('devops/elsewhere', 'issue', 1), text: 'x', kind: 'reply' })).rejects.toThrow('restricted to the configured projects')
  })
})

describe('gitlabThreadContext', () => {
  it('reads one page of notes from the trigger project and hands out the next page cursor while pages stay full', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const notes = Array.from({ length: 100 }, (_, i) => note(100 + i))
    const run = vi.spyOn(commands, 'run').mockResolvedValue(notes.map(note => JSON.stringify(note)).join('\n'))
    const trigger = noteTrigger(notes[0]!, { project: WIDGETS, kind: 'issue', iid: 8 }, GITLAB)!
    const part = await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {} as never)
    expect(part.messages).toHaveLength(100)
    expect(part.next).toBe('2')
    expect(part.messages[0]).toMatchObject({ id: '100', from: 'alice', text: '好' })
    expect(String(run.mock.calls[0]![1][1])).toContain(`projects/${encodeURIComponent(WIDGETS)}/issues/8/notes`)
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
