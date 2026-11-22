/** Merge request binding, lifecycle observation, and terminal IM notification helpers, as `github-pull.ts` has them for PRs.
 * Multi-project port: every MR thread is `gitlab:<project>:mr-<iid>` and every read names its project. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { ticketBranch } from './github-pull.ts'
import { gitlabPage, parseRefId, refId, SOURCE, type GitlabRef } from './gitlab-trigger.ts'
import { KV } from '../kv.ts'

/** An MR as `merge_requests/<iid>` returns it; only this endpoint carries `head_pipeline`. */
export const MrSchema = z.looseObject({
  iid: z.number().int().positive(), title: z.string().nullish(), state: z.string(), web_url: z.string(),
  author: z.looseObject({ username: z.string() }),
  source_branch: z.string(), target_branch: z.string().nullish(), source_project_id: z.number().nullish(), sha: z.string().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), merge_when_pipeline_succeeds: z.boolean().nullish(),
  draft: z.boolean().nullish(), labels: z.array(z.string()).nullish(),
  head_pipeline: z.looseObject({ id: z.number(), sha: z.string().nullish(), status: z.string().nullish() }).nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(),
})
export type Mr = z.infer<typeof MrSchema>
export const readMr = (ctx: Pick<SourceContext, 'commands'>, project: string, iid: number, signal?: AbortSignal): Promise<Mr> =>
  ctx.commands.withSignal(signal).glabApiOn(project, MrSchema, `merge_requests/${iid}`)

/** The ref (`{project, kind:'mr', iid}`) of one followed MR thread, or undefined for non-MR threads. */
const mrRef = (thread: string): GitlabRef | undefined => {
  // Follow records carry the thread KEY (`gitlab:<project>:mr-N`); accept a bare ref id too.
  const bare = thread.startsWith(`${SOURCE}:`) ? thread.slice(SOURCE.length + 1) : thread
  const ref = parseRefId(bare)
  return ref?.kind === 'mr' ? ref : undefined
}
const mrThreadKey = (ref: GitlabRef): string => `${SOURCE}:${refId(ref.project, 'mr', ref.iid)}`
/** The MRs a ticket follows (only the open ones with `open`). */
export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): GitlabRef[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => {
    const ref = mrRef(item.thread)
    return ref ? [ref] : []
  })
/** The MR a ticket card names: the open MR it followed last, else the last one. */
export const mrOf = (ticket: Pick<Ticket, 'follows'>): GitlabRef | undefined => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)

/** The numeric project ids the Source resolved, path → id. */
const projectIds = (ctx: SourceContext): Record<string, number> => ctx.state.get(KV.gitlab.projects) ?? {}
/** True when the agent account opened the MR from a branch of the same configured project, not of a fork. */
export const agentMr = (mr: Pick<Mr, 'author' | 'source_project_id'>, project: string, ctx: SourceContext): boolean =>
  !!ctx.deployment.gitlab && sameName(mr.author.username, ctx.deployment.gitlab.login)
  && mr.source_project_id != null && mr.source_project_id === projectIds(ctx)[project]

const ended = (mr: Pick<Mr, 'state'>): boolean => mr.state === 'merged' || mr.state === 'closed'
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Binds an open MR to a ticket when it is the ticket's source MR, or the agent's MR from the ticket's branch; one MR binds to at
 * most one open ticket. Returns the refusal, or undefined when the MR is bound or not open (which is no refusal).
 */
export function claimMr(ctx: SourceContext, ticketId: string, project: string, mr: Mr): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.kind === 'mr' && source.meta.iid === mr.iid && source.meta.project === project
  const opened = agentMr(mr, project, ctx) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const login = ctx.deployment.gitlab?.login ?? ''
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch of this project whose last path segment is DSH_SUPERAGENT_NAME; omit mr_number when no MR exists`
  }
  const key_ = mrThreadKey({ project, kind: 'mr', iid: mr.iid })
  const owner = ctx.tickets.open().find(item => mrsOf(item, true).some(ref => mrThreadKey(ref) === key_))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === key_)
  if (!ended(mr) && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, project, mr, opened)
  return undefined
}
/**
 * Reconciles a polled MR's state and auto-merge fact with the tickets that follow it or work on its branch. An open agent MR
 * binds to the single open ticket on its branch unless that ticket already follows another open MR.
 * @returns whether the MR has ended.
 */
export async function observeMr(ctx: SourceContext, project: string, mr: Mr): Promise<boolean> {
  const done = ended(mr)
  if (done) closeMr(ctx, project, mr)
  else {
    const candidates = agentMr(mr, project, ctx) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // An MR the ticket followed until it closed, and that is open again, is followed again.
    const key_ = mrThreadKey({ project, kind: 'mr', iid: mr.iid })
    const reopened = ticket?.follows?.some(item => item.thread === key_ && item.closed)
    if (ticket && (reopened || mrsOf(ticket, true).every(ref => mrThreadKey(ref) === key_))) claimMr(ctx, ticket.id, project, mr)
  }
  ctx.threads.describe(mrThreadKey({ project, kind: 'mr', iid: mr.iid }),
    { facts: { autoMerge: !done && mr.merge_when_pipeline_succeeds ? AUTO_MERGE_ON : null } })
  return done
}
function bind(ctx: SourceContext, ticketId: string, project: string, mr: Mr, own: boolean): void {
  const ref: GitlabRef = { project, kind: 'mr', iid: mr.iid }
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: refId(project, 'mr', mr.iid) }, own)
    ctx.threads.patch(mrThreadKey(ref), { iid: mr.iid, isMr: true, project, url: mr.web_url, mrAuthor: mr.author.username })
  })
}
/** Reports a merged or closed MR to the open tickets that follow it; their subscription stays so a later note resumes them. */
function closeMr(ctx: SourceContext, project: string, mr: Mr): void {
  const key_ = mrThreadKey({ project, kind: 'mr', iid: mr.iid })
  if (!ctx.tickets.open().some(ticket => mrsOf(ticket, true).some(ref => mrThreadKey(ref) === key_))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: refId(project, 'mr', mr.iid) }, mr.state === 'merged' ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent notices to a ticket's other conversations once it ended with its MR (the last-closed MR it opened, else the
 * last it followed), in Chinese when the request has Han characters and no kana, otherwise English. GitLab shows the end itself.
 */
export function mrEndNotices(ticket: Ticket, request: string, deployment: Pick<Deployment, 'gitlab'>): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrRef(item.thread))
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow || !deployment.gitlab) return []
  const ref = mrRef(follow.thread)!
  const url = gitlabPage(deployment.gitlab.host, ref.project, 'mr', ref.iid)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${ref.iid}](${url}) 已合并。` : `[MR !${ref.iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${ref.iid}](${url}) has merged.` : `[MR !${ref.iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', ref.project, String(ref.iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
