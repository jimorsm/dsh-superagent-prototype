/** Normalizes GitLab todos, issues, merge requests, and notes into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { GitlabAccount } from '../deployment.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
export type GitlabRef = { project: string; kind: 'issue' | 'mr'; iid: number }
/** Stable Thread id of one issue or merge request; GitLab iids are per-project and per-type, so both qualify the id. */
export const refId = (project: string, kind: 'issue' | 'mr', iid: number | string): string => `${project}:${kind}-${iid}`
/** Parses a Thread ref id back into its project, kind and iid. */
export const parseRefId = (id: string): GitlabRef | undefined => {
  const match = /^([A-Za-z0-9_.\-/]+):(issue|mr)-(\d+)$/.exec(id)
  return match ? { project: match[1]!, kind: match[2] as 'issue' | 'mr', iid: Number(match[3]) } : undefined
}
/** GitLab reply address: the note list of one issue or merge request in one project. */
export const gitlabChannel = (project: string, kind: 'issue' | 'mr', iid: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${refId(project, kind, iid)}`,
    address: { project, kind, iid: String(iid), ...(url ? { url } : {}) } })
export const gitlabPage = (host: string, project: string, kind: 'issue' | 'mr', iid: number | string): string =>
  `${host}/${project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
export const gitlabUser = (text: string, login: string): boolean => new RegExp(`@${escapeRegExp(login)}\\b`, 'i').test(text)

/** A note (comment) as the API returns it in a note list. */
export const NoteSchema = z.looseObject({
  id: z.number().int(), body: z.string().nullish(), system: z.boolean().default(false),
  author: z.looseObject({ username: z.string(), bot: z.boolean().default(false) }).nullish(),
  created_at: z.string(), updated_at: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>

/** A todo as `GET /todos` returns it; only the fields the Source reads. */
export const TodoSchema = z.looseObject({
  id: z.number().int(), action_name: z.string(), target_type: z.string(),
  author: z.looseObject({ username: z.string() }).nullish(),
  target: z.looseObject({ iid: z.number().int(), project_id: z.number().int(), title: z.string().nullish() }),
  target_url: z.string().nullish(), body: z.string().nullish(),
  created_at: z.string(), updated_at: z.string().nullish(),
})
export type GitlabTodo = z.infer<typeof TodoSchema>

/** The Trigger of one note; the agent's own notes produce none. */
export function noteTrigger(note: GitlabNote, ref: GitlabRef, gitlab: GitlabAccount | undefined): Trigger | undefined {
  if (!gitlab) return undefined
  const author = note.author?.username ?? ''
  if (author && sameName(author, gitlab.login)) return undefined
  const id = refId(ref.project, ref.kind, ref.iid)
  const url = `${gitlabPage(gitlab.host, ref.project, ref.kind, ref.iid)}#note_${note.id}`
  return {
    id: key(SOURCE, `${ref.project}-note-${note.id}-${note.updated_at ?? note.created_at}`), source: SOURCE,
    threads: [{ source: SOURCE, id }],
    actor: { source: SOURCE, id: author },
    human: !note.system && !(note.author?.bot ?? false),
    ...(gitlabUser(note.body ?? '', gitlab.login) ? { addressed: 'mention' as const } : {}),
    at: note.updated_at ?? note.created_at,
    text: note.body ?? '',
    channel: gitlabChannel(ref.project, ref.kind, ref.iid, url),
    url,
    meta: { project: ref.project, kind: ref.kind, iid: ref.iid, noteId: note.id },
  }
}

/** The Trigger of one todo; assignment-style actions are unaddressed candidates, mentions address the agent. */
export function todoTrigger(todo: GitlabTodo, project: string, gitlab: GitlabAccount | undefined): Trigger | undefined {
  if (!gitlab) return undefined
  const kind = todo.target_type === 'MergeRequest' ? 'mr' : todo.target_type === 'Issue' ? 'issue' : undefined
  if (!kind) return undefined
  const author = todo.author?.username ?? ''
  if (author && sameName(author, gitlab.login)) return undefined
  const iid = todo.target.iid
  const id = refId(project, kind, iid)
  const url = todo.target_url ?? gitlabPage(gitlab.host, project, kind, iid)
  const mentioned = todo.action_name === 'mentioned' || todo.action_name === 'directly_addressed'
  return {
    id: key(SOURCE, `todo-${todo.id}`), source: SOURCE,
    threads: [{ source: SOURCE, id }],
    actor: { source: SOURCE, id: author },
    human: true,
    ...(mentioned ? { addressed: 'mention' as const } : {}),
    at: todo.updated_at ?? todo.created_at,
    text: todo.body ?? '',
    channel: gitlabChannel(project, kind, iid, url),
    url,
    meta: { project, kind, iid, todoId: todo.id, action: todo.action_name },
  }
}

/** The Trigger of an opened issue or merge request (observe switches), keyed by its creation so it is stable. */
export function openedTrigger(project: string, kind: 'issue' | 'mr', opened: { iid: number; title?: string | null; description?: string | null; created_at: string; author?: { username: string } | null; web_url?: string | null }, gitlab: GitlabAccount | undefined): Trigger | undefined {
  if (!gitlab) return undefined
  const author = opened.author?.username ?? ''
  if (author && sameName(author, gitlab.login)) return undefined
  const id = refId(project, kind, opened.iid)
  const url = opened.web_url ?? gitlabPage(gitlab.host, project, kind, opened.iid)
  return {
    id: key(SOURCE, `${id}-${opened.created_at}`), source: SOURCE,
    threads: [{ source: SOURCE, id }],
    actor: { source: SOURCE, id: author },
    human: true,
    ...(gitlabUser(opened.description ?? '', gitlab.login) ? { addressed: 'mention' as const } : {}),
    at: opened.created_at,
    text: [opened.title, opened.description].filter(Boolean).join('\n\n'),
    channel: gitlabChannel(project, kind, opened.iid, url),
    url,
    meta: { project, kind, iid: opened.iid },
  }
}
