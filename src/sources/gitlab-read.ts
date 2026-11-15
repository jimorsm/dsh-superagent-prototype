/** Read-only GitLab note lists for assessments: the conversation around a Trigger. */
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import { NoteSchema, type GitlabNote } from './gitlab-trigger.ts'
import type { GitlabConfig } from './gitlab.ts'
import type { Trigger } from '../core/index.ts'

const noteMessage = (note: GitlabNote): ContextMessage => ({
  id: String(note.id), from: note.author?.username ?? '', at: note.created_at, text: note.body ?? '',
  ...(note.system || note.author?.bot ? { bot: true as const } : {}),
})
/** Note lists are flat: pages in updated_at order, `next` is the next page number while pages stay full. */
export const gitlabThreadContext: ThreadContext<GitlabConfig> = {
  messageId: (trigger: Trigger) => String(trigger.meta.noteId ?? ''),
  read: async (commands: Commands, trigger: Trigger, _part, cursor): Promise<ContextPart> => {
    const project = String(trigger.meta.project ?? '')
    const kind = trigger.meta.kind === 'mr' ? 'merge_requests' : 'issues'
    const iid = Number(trigger.meta.iid)
    if (!project || !iid) throw new Error('The Trigger names no GitLab thread')
    const page = Math.max(1, Number(cursor) || 1)
    const notes = await commands.glabPagesOn(project, NoteSchema, `${kind}/${iid}/notes?sort=asc&order_by=updated_at&per_page=100&page=${page}`)
    const messages = notes.map(noteMessage)
    return { messages, ...(notes.length === 100 ? { next: String(page + 1) } : {}), body: { messages } }
  },
}
