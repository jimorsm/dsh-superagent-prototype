/** GitLab outbound channel: posts notes on issues and merge requests under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { NoteSchema } from './gitlab-trigger.ts'

/** The target's note list is gone for good: the issue or merge request was deleted. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** Posts a note with an embedded HTML marker so retries do not create duplicate notes. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = commands.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source is not configured')
  const kind = message.channel.address.kind === 'mr' ? 'merge_requests' : 'issues'
  const iid = message.channel.address.iid
  if (!iid) throw new Error('Missing GitLab reply target')
  const path = `${kind}/${iid}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const mine = (note: z.infer<typeof NoteSchema>) => sameName(note.author?.username ?? '', gitlab.login)
      && (note.body ?? '').includes(marker)
    if ((await commands.glabPages(NoteSchema, path)).some(mine)) return 'sent'
    await commands.glabApi(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const iid = address.iid ?? ''
  const mr = address.kind === 'mr'
  return { url: address.url ?? '', label: mr ? { zh: `GitLab MR !${iid}`, en: `GitLab MR !${iid}` } : { zh: `GitLab issue #${iid}`, en: `GitLab issue #${iid}` } }
}
