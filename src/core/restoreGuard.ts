import type { CollectionBeforeOperationHook, GlobalBeforeChangeHook, Payload, PayloadRequest } from 'payload'

import { APIError } from 'payload'

import type { SanitizedBackupPluginConfig } from '../types.js'

import { getLocalTask, isLeaseFresh, readLease } from './lock.js'
import { RESTORE_CONTEXT_KEY } from './restoreBackup.js'

/** How long a server trusts its last look at the lease before asking the database again. */
const CACHE_MS = 2_000

const CACHE_KEY = Symbol.for('payload-plugin-backup.restore-guard')
type Cache = { checkedAt: number; restoring: boolean }
const globalState = globalThis as unknown as Record<symbol, Cache | undefined>

const WRITE_OPERATIONS = new Set(['create', 'delete', 'deleteByID', 'update', 'updateByID'])

const isRestoring = async (payload: Payload, options: SanitizedBackupPluginConfig): Promise<boolean> => {
  if (getLocalTask() === 'restore') {
    return true
  }
  const cached = globalState[CACHE_KEY]
  if (cached && Date.now() - cached.checkedAt < CACHE_MS) {
    return cached.restoring
  }
  const lease = await readLease(payload, options)
  const restoring = Boolean(lease && lease.task === 'restore' && isLeaseFresh(lease))
  globalState[CACHE_KEY] = { checkedAt: Date.now(), restoring }
  return restoring
}

const assertNotRestoring = async (req: PayloadRequest, options: SanitizedBackupPluginConfig) => {
  if (req.context?.[RESTORE_CONTEXT_KEY]) {
    return
  }
  if (await isRestoring(req.payload, options)) {
    throw new APIError(
      'The site is being restored from a backup. Changes are paused until it has finished; try again in a few minutes.',
      503,
    )
  }
}

/**
 * Added to every backed-up collection: rejects creates, updates and deletes
 * while a restore runs on any server, so nothing is written into a database
 * that is about to be replaced (and lost, or mixed with restored content).
 */
export const createRestoreGuard =
  (options: SanitizedBackupPluginConfig): CollectionBeforeOperationHook =>
  async ({ args, operation, req }) => {
    if (WRITE_OPERATIONS.has(operation)) {
      await assertNotRestoring(req, options)
    }
    return args
  }

/** The same for globals, which have no beforeOperation hook. */
export const createGlobalRestoreGuard =
  (options: SanitizedBackupPluginConfig): GlobalBeforeChangeHook =>
  async ({ data, req }) => {
    await assertNotRestoring(req, options)
    return data
  }
