import type { Endpoint, PayloadHandler, PayloadRequest } from 'payload'
import type { ReadableStream as WebReadableStream } from 'stream/web'

import crypto from 'crypto'
import { addDataAndFileToRequest, APIError, headersWithCors } from 'payload'
import { Readable } from 'stream'

import type { BackupRecord } from '../core/createBackup.js'
import type { SanitizedBackupPluginConfig } from '../types.js'

import { createBackup } from '../core/createBackup.js'
import { importBackup, syncFromStorage } from '../core/importBackup.js'
import { restoreBackup } from '../core/restoreBackup.js'
import { runScheduledBackups } from '../core/schedule.js'
import { assertSameStorage } from '../core/storageCheck.js'

/** Typed into the restore dialog; required by the API so a restore is never accidental. */
export const RESTORE_CONFIRMATION = 'RESTORE'

const json = (req: PayloadRequest, body: unknown, status = 200) =>
  Response.json(body, { headers: headersWithCors({ headers: new Headers(), req }), status })

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const withAccess =
  (options: SanitizedBackupPluginConfig, handler: PayloadHandler): PayloadHandler =>
  async (req) => {
    if (!(await options.access({ req }))) {
      return json(req, { errors: [{ message: 'You are not allowed to manage backups.' }] }, 403)
    }
    try {
      return await handler(req)
    } catch (error) {
      const status = error instanceof APIError ? error.status : 500
      if (status >= 500) {
        req.payload.logger.error({ err: error, msg: '[payload-plugin-backup] Request failed' })
      }
      return json(req, { errors: [{ message: errorMessage(error) }] }, status)
    }
  }

/** Constant-time check of `Authorization: Bearer <cronSecret>`. */
const hasCronSecret = (req: PayloadRequest, secret?: string): boolean => {
  const header = req.headers.get('authorization') ?? ''
  if (!secret || !header.startsWith('Bearer ')) {
    return false
  }
  const given = crypto.createHash('sha256').update(header.slice(7)).digest()
  const expected = crypto.createHash('sha256').update(secret).digest()
  return crypto.timingSafeEqual(given, expected)
}

const readJSON = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  await addDataAndFileToRequest(req)
  return (req.data ?? {}) as Record<string, unknown>
}

const getRecord = async (req: PayloadRequest, options: SanitizedBackupPluginConfig) =>
  (await req.payload.findByID({
    id: req.routeParams?.id as string,
    collection: options.slug,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
  })) as BackupRecord | null

export const createBackupEndpoints = (options: SanitizedBackupPluginConfig): Endpoint[] => [
  {
    // POST /api/backups/run  { includeMedia?: boolean }
    handler: withAccess(options, async (req) => {
      const body = await readJSON(req)
      const backup = await createBackup({
        type: 'manual',
        includeMedia: body.includeMedia !== false,
        options,
        payload: req.payload,
        user: req.user,
      })
      return json(req, { doc: backup, message: 'Backup created.' }, 201)
    }),
    method: 'post',
    path: '/run',
  },
  {
    // POST /api/backups/import?filename=site.tar.gz  (raw .tar.gz body)
    handler: withAccess(options, async (req) => {
      if (!req.body) {
        return json(req, { errors: [{ message: 'Send the backup archive as the request body.' }] }, 400)
      }
      const { backup, warnings } = await importBackup({
        options,
        originalFilename: req.searchParams.get('filename') ?? undefined,
        payload: req.payload,
        stream: Readable.fromWeb(req.body as unknown as WebReadableStream),
        user: req.user,
      })
      return json(req, { doc: backup, message: 'Backup imported.', warnings }, 201)
    }),
    method: 'post',
    path: '/import',
  },
  {
    // GET /api/backups/cron  (Authorization: Bearer <cronSecret>, or a signed-in admin)
    // Takes a backup if a daily/weekly/monthly one is due. Call it every 5-15 minutes.
    handler: async (req) => {
      if (!hasCronSecret(req, options.schedule.cronSecret) && !(await options.access({ req }))) {
        return json(req, { errors: [{ message: 'Invalid cron secret.' }] }, 401)
      }
      try {
        const result = await runScheduledBackups({ options, payload: req.payload })
        return json(req, {
          backupId: result.backup?.id,
          deleted: result.deleted,
          frequencies: result.frequencies,
          message: result.reason ?? `Created ${result.frequencies.join(' + ')} backup.`,
        })
      } catch (error) {
        req.payload.logger.error({ err: error, msg: '[payload-plugin-backup] Scheduled backup failed' })
        return json(req, { errors: [{ message: errorMessage(error) }] }, 500)
      }
    },
    method: 'get',
    path: '/cron',
  },
  {
    // POST /api/backups/sync  -> adds archives found in storage to the list
    handler: withAccess(options, async (req) => {
      const result = await syncFromStorage({ options, payload: req.payload, user: req.user })
      return json(req, {
        added: result.added.length,
        message: `Found ${result.added.length} new backup(s) in storage.`,
        skipped: result.skipped,
      })
    }),
    method: 'post',
    path: '/sync',
  },
  {
    // GET /api/backups/:id/download
    handler: withAccess(options, async (req) => {
      const backup = await getRecord(req, options)
      if (!backup || backup.status !== 'completed') {
        return json(req, { errors: [{ message: 'Backup not found.' }] }, 404)
      }
      assertSameStorage(backup, options)
      const stream = await options.storage.download({ filename: backup.filename })
      const headers = headersWithCors({ headers: new Headers(), req })
      headers.set('Content-Type', 'application/gzip')
      headers.set('Content-Disposition', `attachment; filename="${backup.filename}"`)
      if (typeof backup.size === 'number') {
        headers.set('Content-Length', String(backup.size))
      }
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { headers })
    }),
    method: 'get',
    path: '/:id/download',
  },
  {
    // POST /api/backups/:id/restore  { confirm: 'RESTORE' }
    handler: withAccess(options, async (req) => {
      const body = await readJSON(req)
      if (body.confirm !== RESTORE_CONFIRMATION) {
        return json(
          req,
          { errors: [{ message: `Send { "confirm": "${RESTORE_CONFIRMATION}" } to restore.` }] },
          400,
        )
      }
      const backup = await getRecord(req, options)
      if (!backup) {
        return json(req, { errors: [{ message: 'Backup not found.' }] }, 404)
      }
      const result = await restoreBackup({
        id: backup.id,
        options,
        payload: req.payload,
        user: req.user,
      })
      return json(req, { message: 'Backup restored.', ...result })
    }),
    method: 'post',
    path: '/:id/restore',
  },
]
