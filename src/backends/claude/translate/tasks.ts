/** Track Task* result state and TodoWrite snapshots for the todo panel. */
import type { AgentEvent, AgentEventOf } from '../../../agent/events.js'
import type { TodoPanelItem } from '../../../agent/index.js'
import { t } from '../../../i18n.js'
import { arr, rec, str } from '../narrow.js'
import { claudeToolRole } from '../tools.js'
import type { ClaudeTaskSeed, ClaudeTranslatorOptions, TrackedTask } from './types.js'

export function createTaskTools(options: ClaudeTranslatorOptions) {
  /** The session's plan-tracking tasks (the Task* family), projected onto
   *  the shared todo panel as full `todo.write` snapshots. */
  const trackedTasks = new Map<string, TrackedTask>()
  /** Task creation counter: the snapshots' row order. */
  let taskSeq = 0
  // A resumed conversation's tasks start the live table (copied: two
  // sessions seeded from one replay never share a record).
  for (const seed of options.start?.tasks ?? []) {
    const record: TrackedTask = {
      content: seed.content,
      status: seed.status,
      ...(seed.activeForm === undefined ? {} : { activeForm: seed.activeForm }),
      seq: seed.seq,
    }
    trackedTasks.set(seed.id, record)
    taskSeq = Math.max(taskSeq, seed.seq)
  }

  /** The tracked tasks as one full todo snapshot (creation order; a deleted
   *  task is simply absent). */
  const taskSnapshot = (): AgentEventOf<'todo.write'> => ({
    type: 'todo.write',
    items: [...trackedTasks.entries()].sort((a, b) => a[1].seq - b[1].seq).map(([, task]) => ({ content: task.content, status: task.status })),
  })

  /** A task status the panel shows (`deleted` is not one — it removes). */
  const panelStatus = (value: unknown): TodoPanelItem['status'] | undefined =>
    value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined

  /** The tracked tasks as resume seeds (creation order; see {@link ClaudeTaskSeed}). */
  const taskSeeds = (): readonly ClaudeTaskSeed[] =>
    [...trackedTasks.entries()].sort((a, b) => a[1].seq - b[1].seq).map(([id, task]) => ({
      id,
      content: task.content,
      status: task.status,
      ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
      seq: task.seq,
    }))

  /** A task record from a Task* result (`{id, subject, status}`), narrowed;
   *  undefined when the record is missing or not a panel status. */
  const taskRecord = (value: unknown): { id: string; content: string; status: TodoPanelItem['status'] } | undefined => {
    const task = rec(value)
    const id = str(task?.id)
    const content = str(task?.subject)
    const status = task?.status
    if (id === undefined || content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return undefined
    return { id, content, status }
  }

  const applyTaskInput = (out: AgentEvent[], name: string, input: unknown): void => {
    if (claudeToolRole(name) === 'todo') {
      if (name === 'TodoWrite') {
        const todos = arr(rec(input)?.todos).flatMap((item): TodoPanelItem[] => {
          const todo = rec(item)
          const content = str(todo?.content)
          const status = todo?.status
          if (content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return []
          return [{ content, status }]
        })
        out.push({ type: 'todo.write', items: todos })
      }
      // Task* changes apply only when their results arrive.
    }
  }

  const applyTaskResult = (out: AgentEvent[], call: { readonly name: string; readonly input: unknown } | undefined, isError: boolean, structured: unknown, openCalls: Map<string, { readonly name: string; readonly input: unknown; readonly turn: number; readonly lane?: string }>): void => {
    if (call !== undefined && !isError && (call.name === 'TodoWrite' || (call.name === 'TaskList' && Array.isArray(rec(structured)?.tasks)))) {
      // A whole-list result supersedes inputs of earlier updates.
      for (const [id, pending] of openCalls) {
        if (pending.name === 'TaskUpdate' && pending.lane === undefined) openCalls.set(id, { ...pending, input: undefined })
      }
      if (call.name === 'TodoWrite') trackedTasks.clear()
    }
    // The task family (2.1.284+): a create's record names the id its
    // call lacked; a list/get result is the authoritative state and
    // overwrites what the inputs built (the CLI owns the tasks).
    if (call !== undefined && !isError && call.name !== 'TodoWrite' && claudeToolRole(call.name) === 'todo') {
      const record = rec(structured)
      if (call.name === 'TaskUpdate' && call.input !== undefined) {
        const patch = rec(call.input)
        const id = str(patch?.taskId) ?? str(record?.taskId)
        if (patch !== undefined && id !== undefined) {
          const known = trackedTasks.get(id)
          if (patch.status === 'deleted') {
            if (trackedTasks.delete(id)) out.push(taskSnapshot())
          } else {
            const status = panelStatus(patch.status) ?? panelStatus(rec(record?.statusChange)?.to) ?? known?.status
            if (status !== undefined) {
              trackedTasks.set(id, {
                content: str(patch.subject) ?? known?.content ?? t('claude-task-unnamed', { id }),
                status,
                activeForm: str(patch.activeForm) ?? known?.activeForm,
                seq: known?.seq ?? ++taskSeq,
              })
              out.push(taskSnapshot())
            }
          }
        }
      } else if (call.name === 'TaskCreate') {
        // The record carries no status (a fresh task is pending).
        const created = rec(record?.task)
        const id = str(created?.id)
        const content = str(rec(call.input)?.subject) ?? str(created?.subject)
        if (id !== undefined && content !== undefined) {
          const activeForm = str(rec(call.input)?.activeForm)
          const created: TrackedTask = {
            content,
            status: 'pending',
            ...(activeForm === undefined ? {} : { activeForm }),
            seq: ++taskSeq,
          }
          trackedTasks.set(id, created)
          out.push(taskSnapshot())
        }
      } else if (call.name === 'TaskList') {
        // Only a real list syncs (a missing/malformed result must not
        // clear the panel); an empty list is a legitimate clear.
        if (Array.isArray(record?.tasks)) {
          const next = new Map<string, TrackedTask>()
          for (const item of arr(record?.tasks)) {
            const task = taskRecord(item)
            if (task === undefined) continue
            const known = trackedTasks.get(task.id)
            next.set(task.id, { content: task.content, status: task.status, ...(known?.activeForm === undefined ? {} : { activeForm: known.activeForm }), seq: known?.seq ?? ++taskSeq })
          }
          trackedTasks.clear()
          for (const [id, task] of next) {
            trackedTasks.set(id, task)
          }
          out.push(taskSnapshot())
        }
      } else if (call.name === 'TaskGet') {
        // `task: null` is a not-found: local state stands.
        const task = taskRecord(record?.task)
        if (task !== undefined) {
          const known = trackedTasks.get(task.id)
          const fetched: TrackedTask = { content: task.content, status: task.status, ...(known?.activeForm === undefined ? {} : { activeForm: known.activeForm }), seq: known?.seq ?? ++taskSeq }
          trackedTasks.set(task.id, fetched)
          out.push(taskSnapshot())
        }
      }
    }
  }

  return {
    trackedTasks,
    taskSeeds,
    applyTaskInput,
    applyTaskResult,
    get taskSeq() { return taskSeq },
    set taskSeq(value: number) { taskSeq = value },
  }
}
