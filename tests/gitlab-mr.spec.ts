import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Commands } from '../src/infra/commands.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { agentMr, claimMr, mrEndNotices, mrOf, mrsOf, observeMr, type Mr } from '../src/sources/gitlab-mr.ts'

vi.setConfig({ testTimeout: 30_000 })

const GITLAB = { cli: '/path/agent-glab', host: 'https://gitlab.example.com', projects: ['devops/sandbox', 'devops/widgets'], login: 'agent-bot', noreply: '7_agent-bot@users.noreply.gitlab.example.com' }
const deployment = testDeployment({ gitlab: GITLAB })
const SANDBOX = 'devops/sandbox'

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-mr-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { gitlab: { enabled: true, config: { host: GITLAB.host, projects: [{ project: SANDBOX }], cli: GITLAB.cli } } },
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
  const deps: SourceContextDeps = { store, engine, outbox: { outboxSend: undefined, send: (m: never) => { store.receipts.add(m) } } as never, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const h = { ...deps, store, engine, commands, receive, ctx: sourceContextOf(deps, gitlabKind) }
  h.store.set(KV.gitlab.projects, { [SANDBOX]: 424 })
  return h
}

const mr = (iid: number, overrides: Record<string, unknown> = {}): Mr => ({
  iid, title: '修 README', state: 'opened', web_url: `https://gitlab.example.com/devops/sandbox/-/merge_requests/${iid}`,
  author: { username: 'carol' }, source_branch: 'agent/fix-1', target_branch: 'main', source_project_id: 424,
  ...overrides,
}) as Mr
const agentsMr = (iid: number, branch = 'agent/fix-1'): Mr => mr(iid, { author: { username: 'agent-bot' }, source_branch: branch })
const endedMr = (iid: number, at: string, merged = true): Mr =>
  mr(iid, { author: { username: 'agent-bot' }, state: merged ? 'merged' : 'closed', ...(merged ? { merged_at: at } : { closed_at: at }) })

const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
const openTicket = (id: string, name: string) => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit' as const, policyVersion: '', basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'alice' }, scope: '' },
  channels: [], assignments: [{ id: 'a1', state: 'running' as const, createdAt: '2026-11-22T00:00:00Z' }], inputs: [], undelivered: [],
  execution: execution(name), origin: { triggerId: 'x', triggerIds: [] }, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' })

describe('gitlab-mr', () => {
  it('agentMr 只认本项目的机器人 MR，fork 来的不算', () => {
    const h = host()
    expect(agentMr(agentsMr(1), SANDBOX, h.ctx)).toBe(true)
    expect(agentMr(mr(1), SANDBOX, h.ctx)).toBe(false)  // 别人开的
    expect(agentMr(agentsMr(1, 'agent/x'), SANDBOX, h.ctx) && agentMr(mr(1, { author: { username: 'agent-bot' }, source_project_id: 999 }), SANDBOX, h.ctx)).toBe(false)  // fork 仓开的
    h.store.close()
  })
  it('claimMr 绑定工单分支上的机器人 MR，拒绝无关 MR 与二主', async () => {
    const h = host()
    h.store.tickets.save(openTicket('t1', 'fix-1') as never)
    h.store.tickets.save(openTicket('t2', 'fix-2') as never)
    expect(claimMr(h.ctx, 't1', SANDBOX, mr(9, { author: { username: 'carol' } }))).toContain('does not belong')
    expect(claimMr(h.ctx, 't1', SANDBOX, agentsMr(9))).toBeUndefined()
    expect(mrOf(h.store.tickets.get('t1')! as never)).toMatchObject({ project: SANDBOX, iid: 9 })
    expect(h.store.threads.get('gitlab:devops/sandbox:mr-9')?.subscriptions).toEqual(['t1'])
    expect(claimMr(h.ctx, 't2', SANDBOX, agentsMr(9, 'agent/fix-2'))).toContain('another active ticket')
    h.store.close()
  })
  it('observeMr 自动绑定唯一匹配分支的工单；MR 合并后工单收尾', async () => {
    const h = host()
    h.store.tickets.save(openTicket('t1', 'fix-1') as never)
    expect(await observeMr(h.ctx, SANDBOX, agentsMr(9))).toBe(false)
    expect(mrsOf(h.store.tickets.get('t1')! as never, true)).toHaveLength(1)
    expect(await observeMr(h.ctx, SANDBOX, endedMr(9, '2026-11-22T01:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged', at: '2026-11-22T01:00:00.000Z' } })
    h.store.close()
  })
  it('mrEndNotices 按请求语言写终态通知，且只对其他渠道发', () => {
    const h = host()
    const ticket = { ...openTicket('t1', 'fix-1'),
      channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1' } }, { source: 'gitlab', thread: 'gitlab:devops/sandbox:issue-8', address: {} }],
      follows: [{ thread: 'devops/sandbox:mr-9', own: true, closed: { at: '2026-11-22T01:00:00Z', outcome: 'merged' as const } }],
      ended: { outcome: 'merged' as const, at: '2026-11-22T01:00:00Z' } }
    const zh = mrEndNotices(ticket as never, '帮我修一下', deployment)
    expect(zh).toHaveLength(1)
    expect(zh[0]!.channel.source).toBe('feishu')
    expect(zh[0]!.text).toContain('已合并')
    expect(zh[0]!.text).toContain('/merge_requests/9')
    expect(mrEndNotices(ticket as never, 'fix this please', deployment)[0]!.text).toContain('has merged')
    expect(mrEndNotices({ ...ticket, ended: undefined } as never, '帮我修一下', deployment)).toEqual([])
    h.store.close()
  })
})
