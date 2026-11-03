import type { Payload, Where } from 'payload'

import crypto from 'crypto'
import os from 'os'
import { APIError } from 'payload'

import type { BackupRecord, SanitizedBackupPluginConfig } from '../types.js'

import { notify } from './callbacks.js'
import { getDatabaseKind } from './database.js'

/**
 * One backup or restore at a time, across every server that shares the
 * database. A backup taken while a restore is writing (or two restores at
 * once) would mix old and new content.
 *
 * The lock is a lease: a single row in the hidden lock collection, renewed by
 * a heartbeat while the task runs. A server that crashes stops renewing it, so
 * after `STALE_AFTER` the next task takes it over and the interrupted backup
 * is marked as failed. Within one process, an in-memory flag answers first
 * (kept on globalThis, so Next.js hot reloads share it).
 */
export type Task = 'backup' | 'restore'

export const LEASE_ID = 'lease'
/** How often a running task renews its lease. */
export const HEARTBEAT_INTERVAL = 15_000
/** A lease not renewed for this long belongs to a server that stopped or crashed. */
export const STALE_AFTER = 2 * 60_000

type Lease = { heartbeatAt: number; owner: string; startedAt: number; task: Task }
type LockState = { owner: string; task?: Task }

const LOCK_KEY = Symbol.for('payload-plugin-backup.lock')
const globalState = globalThis as unknown as Record<symbol, LockState | undefined>
const state = (globalState[LOCK_KEY] ??= {
  owner: `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`,
})

/** Identifies this server process in the lease. */
export const getLockOwner = () => state.owner

const busy = (task: string, elsewhere: boolean) =>
  new APIError(
    `A ${task} is already in progress${elsewhere ? ' on another server' : ''}. Try again when it has finished.`,
    409,
  )

const leaseWhere = (extra?: Where): Where => ({
  and: [{ id: { equals: LEASE_ID } }, ...(extra ? [extra] : [])],
})

const isBusy = (error: unknown): boolean => {
  const { cause, code, message } = (error ?? {}) as { cause?: unknown; code?: string; message?: string }
  return code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/.test(message ?? '') || (cause ? isBusy(cause) : false)
}

/**
 * SQLite allows one writer at a time; right after a restore commits (or while
 * another write runs) a lock write can fail with SQLITE_BUSY. Retry briefly.
 */
const retryWhileBusy = async <T>(write: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write()
    } catch (error) {
      if (!isBusy(error) || attempt >= 20) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

/** SQL adapters need `atomic` to apply the `where` in the UPDATE itself (compare-and-set). */
const atomicOptions = (payload: Payload) =>
  getDatabaseKind(payload) === 'mongodb' ? {} : { options: { atomic: true } }

export const readLease = async (
  payload: Payload,
  options: SanitizedBackupPluginConfig,
): Promise<Lease | undefined> => {
  const lease = await payload.db.findOne<{ id: string } & Record<string, unknown>>({
    collection: options.lockSlug,
    where: leaseWhere(),
  })
  return lease
    ? {
        heartbeatAt: Number(lease.heartbeatAt),
        owner: String(lease.owner),
        startedAt: Number(lease.startedAt),
        task: lease.task as Task,
      }
    : undefined
}

export const isLeaseFresh = (lease: Lease, now = Date.now()) => now - lease.heartbeatAt < STALE_AFTER

/** The task running in this process, or on any server holding a live lease. */
export const getActiveTask = async (
  payload: Payload,
  options: SanitizedBackupPluginConfig,
): Promise<Task | undefined> => {
  if (state.task) {
    return state.task
  }
  const lease = await readLease(payload, options)
  return lease && isLeaseFresh(lease) ? lease.task : undefined
}

/** The task running in this process only (no database query). */
export const getLocalTask = () => state.task

const acquireLease = async (
  payload: Payload,
  options: SanitizedBackupPluginConfig,
  task: Task,
): Promise<void> => {
  const now = Date.now()
  const data = { heartbeatAt: now, owner: state.owner, startedAt: now, task }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await retryWhileBusy(() =>
        payload.db.create({
          collection: options.lockSlug,
          customID: LEASE_ID,
          data: { id: LEASE_ID, ...data },
          returning: false,
        }),
      )
      return
    } catch (createError) {
      const current = await readLease(payload, options)
      if (!current) {
        // Released between our insert and the read: try again.
        if (attempt === 2) {
          throw createError
        }
        continue
      }
      // This process runs one task at a time (checked before), so a lease in
      // its own name is left over from an earlier task that couldn't release it.
      const leftOver = current.owner === state.owner
      if (isLeaseFresh(current) && !leftOver) {
        throw busy(current.task, true)
      }

      // The owner stopped renewing it. Take it over, but only if nobody else
      // did in the meantime: the update matches the exact heartbeat we saw.
      const taken = await retryWhileBusy(() =>
        payload.db.updateOne({
          collection: options.lockSlug,
          data,
          where: leaseWhere({ heartbeatAt: { equals: current.heartbeatAt } }),
          ...atomicOptions(payload),
        }),
      )
      if (taken) {
        if (!leftOver) {
          payload.logger.warn(
            `[payload-plugin-backup] Took over the lock of a ${current.task} on ${current.owner}, which stopped responding ${Math.round((now - current.heartbeatAt) / 1000)}s ago.`,
          )
        }
        return
      }
    }
  }
  throw new APIError('Another server took the backup lock first. Try again.', 409)
}

const renewLease = async (payload: Payload, options: SanitizedBackupPluginConfig) => {
  const renewed = await payload.db.updateOne({
    collection: options.lockSlug,
    data: { heartbeatAt: Date.now() },
    where: leaseWhere({ owner: { equals: state.owner } }),
    ...atomicOptions(payload),
  })
  if (!renewed) {
    throw new Error('the lease is no longer held by this server')
  }
}

const releaseLease = async (payload: Payload, options: SanitizedBackupPluginConfig) => {
  await retryWhileBusy(() =>
    payload.db.deleteOne({
      collection: options.lockSlug,
      returning: false,
      where: leaseWhere({ owner: { equals: state.owner } }),
    }),
  )
}

/**
 * Backups still "running" while nobody holds the lease were interrupted (the
 * server stopped, crashed or hit a time limit). Called right after taking the
 * lease, before this task creates its own record.
 */
const failInterruptedBackups = async (payload: Payload, options: SanitizedBackupPluginConfig) => {
  const { docs } = await payload.update({
    collection: options.slug,
    data: {
      completedAt: new Date().toISOString(),
      error:
        'Interrupted before it could finish: the server stopped, crashed or reached a time limit.',
      status: 'failed',
    },
    overrideAccess: true,
    where: { status: { equals: 'running' } },
  })
  if (docs.length) {
    payload.logger.warn(
      `[payload-plugin-backup] Marked ${docs.length} interrupted backup(s) as failed: ${docs.map((doc) => String(doc.filename)).join(', ')}.`,
    )
  }
  for (const doc of docs) {
    await notify(payload, 'afterBackupFailed', () =>
      options.afterBackupFailed?.({
        backup: doc as unknown as BackupRecord,
        error: new Error(String(doc.error)),
        payload,
      }),
    )
  }
}

export const withLock = async <T>(
  {
    options,
    payload,
    task,
  }: { options: SanitizedBackupPluginConfig; payload: Payload; task: Task },
  run: () => Promise<T>,
): Promise<T> => {
  if (state.task) {
    throw busy(state.task, false)
  }
  state.task = task

  let heartbeat: NodeJS.Timeout | undefined
  let leased = false
  try {
    await acquireLease(payload, options, task)
    leased = true

    let warned = false
    // SQLite has one writer: a restore transaction holds it until it commits,
    // and a write attempted meanwhile fails and can keep the database locked.
    // A restore on SQLite skips renewals; SQLite sites run on one server,
    // where the in-process lock already keeps tasks apart.
    const renews = !(task === 'restore' && getDatabaseKind(payload) === 'sqlite')
    heartbeat = setInterval(() => {
      if (!renews) {
        return
      }
      renewLease(payload, options).then(
        () => {
          warned = false
        },
        (error: unknown) => {
          if (!warned) {
            warned = true
            payload.logger.warn({
              err: error,
              msg: `[payload-plugin-backup] Could not renew the ${task} lock; other servers may treat this ${task} as interrupted.`,
            })
          }
        },
      )
    }, HEARTBEAT_INTERVAL)
    heartbeat.unref()

    await failInterruptedBackups(payload, options)
    return await run()
  } finally {
    clearInterval(heartbeat)
    if (leased) {
      await releaseLease(payload, options).catch((error: unknown) => {
        payload.logger.error({ err: error, msg: '[payload-plugin-backup] Could not release the lock' })
      })
    }
    state.task = undefined
  }
}
