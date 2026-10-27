import { APIError } from 'payload'

/**
 * One backup or restore at a time. A backup taken while a restore is writing
 * (or two restores at once) would mix old and new content. Kept on globalThis
 * so Next.js hot reloads, which load the module again, share the same lock.
 */
const LOCK_KEY = Symbol.for('payload-plugin-backup.lock')
type LockState = { task?: 'backup' | 'restore' }
const globalState = globalThis as unknown as Record<symbol, LockState | undefined>
const state = (globalState[LOCK_KEY] ??= {})

/** The backup or restore currently running in this process, if any. */
export const getRunningTask = () => state.task

export const withLock = async <T>(task: 'backup' | 'restore', run: () => Promise<T>): Promise<T> => {
  if (state.task) {
    throw new APIError(
      `A ${state.task} is already in progress. Try again when it has finished.`,
      409,
    )
  }
  state.task = task
  try {
    return await run()
  } finally {
    state.task = undefined
  }
}
