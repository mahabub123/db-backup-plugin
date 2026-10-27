import type { Payload, PayloadRequest, TypedUser, Where } from 'payload'

import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { createLocalReq } from 'payload'
import { pipeline } from 'stream/promises'
import * as tar from 'tar'

import type {
  BackupFrequency,
  BackupManifest,
  BackupType,
  SanitizedBackupPluginConfig,
} from '../types.js'

import { createBackupFilename } from '../utilities/filename.js'
import { getPackageVersions } from '../utilities/versions.js'
import { getBackupCollections, getBackupGlobals, getMediaCollections } from './entities.js'
import { withLock } from './lock.js'
import { copyFileToArchive, getArchiveMediaPath, getDocumentFiles } from './media.js'
import { createNdjsonWriter } from './ndjson.js'
import { applyRetention } from './retention.js'

export type CreateBackupArgs = {
  /** For scheduled backups: which schedules (daily, weekly, monthly) this backup counts for. */
  frequencies?: BackupFrequency[]
  /** Include the files of upload collections. @default true */
  includeMedia?: boolean
  /** Recorded start time; the scheduler passes the time it checked. @default now */
  now?: Date
  options: SanitizedBackupPluginConfig
  payload: Payload
  type?: BackupType
  user?: null | TypedUser
}

export type BackupRecord = {
  [key: string]: unknown
  checksum?: null | string
  filename: string
  id: number | string
  includesMedia?: boolean | null
  status: string
}

/** How a user is shown in the `createdBy` column. */
export const describeUser = (user?: null | TypedUser): string | undefined => {
  if (!user) {
    return undefined
  }
  const email = (user as { email?: unknown }).email
  return typeof email === 'string' ? email : String(user.id)
}

export const sha256File = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

type Row = Record<string, unknown>

/**
 * Reads every row in batches of `limit`. Each batch continues right after the
 * last row of the previous one (`after`), instead of skipping a number of
 * pages: that stays fast on large tables, and needs no count per batch.
 */
async function* readInBatches({
  after,
  find,
  limit,
}: {
  after: (last: Row) => Where
  find: (where?: Where) => Promise<Row[]>
  limit: number
}): AsyncGenerator<Row[]> {
  let where: undefined | Where
  for (;;) {
    const rows = await find(where)
    if (rows.length) {
      yield rows
    }
    if (rows.length < limit) {
      return
    }
    where = after(rows[rows.length - 1])
  }
}

/**
 * Versions are exported oldest first, which a restore needs to set the
 * `latest` flag right. The id breaks ties between equal timestamps.
 */
const VERSION_SORT = ['updatedAt', 'id']

const afterVersion = (last: Row): Where => ({
  or: [
    { updatedAt: { greater_than: last.updatedAt } },
    { and: [{ updatedAt: { equals: last.updatedAt } }, { id: { greater_than: last.id } }] },
  ],
})

/**
 * Writes the full content of the site into `dir`:
 *
 *   manifest.json
 *   collections/<slug>.ndjson         every document, exactly as stored
 *   versions/<slug>.ndjson            version history of the collection
 *   globals/<slug>.json
 *   global-versions/<slug>.ndjson
 *   media/<collection>/[prefix/]file  original upload files and image sizes
 *
 * Documents are read through the database adapter (not the Local API) so no
 * hooks or access control get in the way and hidden fields, such as password
 * hashes, are kept. Documents keep their ids, so relationships survive a
 * restore. Restore into the same database engine the backup was taken from:
 * MongoDB ids and SQL ids are not interchangeable.
 */
export const writeBackupContents = async ({
  dir,
  includeMedia,
  options,
  payload,
  req,
}: {
  dir: string
  includeMedia: boolean
  options: SanitizedBackupPluginConfig
  payload: Payload
  req: PayloadRequest
}): Promise<BackupManifest> => {
  const { payloadVersion, pluginVersion } = getPackageVersions()
  const manifest: BackupManifest = {
    collections: [],
    createdAt: new Date().toISOString(),
    databaseAdapter: payload.db.packageName ?? payload.db.name,
    formatVersion: 1,
    globals: [],
    media: [],
    payloadVersion,
    pluginVersion,
  }

  for (const folder of ['collections', 'versions', 'globals', 'global-versions', 'media']) {
    await fsp.mkdir(path.join(dir, folder), { recursive: true })
  }

  const mediaCollections = includeMedia
    ? getMediaCollections(payload, options).map(({ slug }) => slug)
    : []

  for (const collection of getBackupCollections(payload, options)) {
    const { slug } = collection
    const writer = createNdjsonWriter(path.join(dir, 'collections', `${slug}.ndjson`))
    const media = mediaCollections.includes(slug)
      ? { collection: slug, files: 0, missing: [] as string[] }
      : null

    const batches = readInBatches({
      after: (last) => ({ id: { greater_than: last.id } }),
      find: async (where) =>
        (
          await payload.db.find({
            collection: slug,
            joins: false,
            limit: options.batchSize,
            pagination: false,
            req,
            sort: 'id',
            where,
          })
        ).docs,
      limit: options.batchSize,
    })

    for await (const batch of batches) {
      for (const doc of batch) {
        await writer.write(doc)

        if (media) {
          for (const file of getDocumentFiles(doc)) {
            const copied = await copyFileToArchive({
              collection,
              destination: getArchiveMediaPath(dir, slug, file),
              doc,
              file,
              req,
            })
            if (copied) {
              media.files++
            } else {
              media.missing.push([file.prefix, file.filename].filter(Boolean).join('/'))
            }
          }
        }
      }
    }

    const count = await writer.close()
    let versions = 0

    if (options.includeVersions && collection.versions) {
      const versionWriter = createNdjsonWriter(path.join(dir, 'versions', `${slug}.ndjson`))
      const batches = readInBatches({
        after: afterVersion,
        find: async (where) =>
          (
            await payload.db.findVersions({
              collection: slug,
              limit: options.batchSize,
              pagination: false,
              req,
              sort: VERSION_SORT,
              where,
            })
          ).docs,
        limit: options.batchSize,
      })
      for await (const batch of batches) {
        for (const version of batch) {
          await versionWriter.write(version)
        }
      }
      versions = await versionWriter.close()
    }

    manifest.collections.push({ slug, count, versions })
    if (media) {
      if (media.missing.length) {
        payload.logger.warn(
          `[payload-plugin-backup] ${media.missing.length} file(s) of "${slug}" could not be found and are missing from the backup.`,
        )
      }
      manifest.media.push(media)
    }
  }

  for (const global of getBackupGlobals(payload, options)) {
    const { slug } = global
    const doc = (await payload.db.findGlobal({ slug, req })) as Record<string, unknown> | undefined
    const exists = Boolean(doc && Object.keys(doc).length > 0)

    if (exists) {
      await fsp.writeFile(path.join(dir, 'globals', `${slug}.json`), JSON.stringify(doc))
    }

    let versions = 0
    if (options.includeVersions && global.versions) {
      const versionWriter = createNdjsonWriter(path.join(dir, 'global-versions', `${slug}.ndjson`))
      const batches = readInBatches({
        after: afterVersion,
        find: async (where) =>
          (
            await payload.db.findGlobalVersions({
              global: slug,
              limit: options.batchSize,
              pagination: false,
              req,
              sort: VERSION_SORT,
              where,
            })
          ).docs,
        limit: options.batchSize,
      })
      for await (const batch of batches) {
        for (const version of batch) {
          await versionWriter.write(version)
        }
      }
      versions = await versionWriter.close()
    }

    manifest.globals.push({ slug, exists, versions })
  }

  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  return manifest
}

/**
 * Creates a complete backup of the site (database + uploaded files), stores
 * it with the configured storage adapter and records it in the backups
 * collection. Failed backups are recorded too, with the error message.
 * Throws a 409 APIError while another backup or restore is running.
 */
export const createBackup = (args: CreateBackupArgs): Promise<BackupRecord> =>
  withLock('backup', () => takeBackup(args))

/** `createBackup` without the lock, for the safety backup a restore takes while holding it. */
export const takeBackup = async ({
  type = 'manual',
  frequencies,
  includeMedia = true,
  now = new Date(),
  options,
  payload,
  user,
}: CreateBackupArgs): Promise<BackupRecord> => {
  const filename = createBackupFilename(now)
  const startedAt = now.toISOString()
  const withMedia = includeMedia && options.media.enabled

  const record = (await payload.create({
    collection: options.slug,
    data: {
      type,
      createdBy: describeUser(user),
      filename,
      frequencies,
      includesMedia: withMedia,
      startedAt,
      status: 'running',
      storage: options.storage.name,
    },
    overrideAccess: true,
  })) as unknown as BackupRecord

  await fsp.mkdir(options.tempDir, { recursive: true })
  const workDir = await fsp.mkdtemp(path.join(options.tempDir, 'payload-backup-'))

  try {
    const req = await createLocalReq({ user: user ?? undefined }, payload)
    const dataDir = path.join(workDir, 'data')
    const manifest = await writeBackupContents({
      dir: dataDir,
      includeMedia: withMedia,
      options,
      payload,
      req,
    })

    const archivePath = path.join(workDir, filename)
    await tar.create({ cwd: dataDir, file: archivePath, gzip: true, portable: true }, ['.'])

    const { size } = await fsp.stat(archivePath)
    const checksum = await sha256File(archivePath)
    await options.storage.upload({ filename, filePath: archivePath, size })

    const completed = (await payload.update({
      id: record.id,
      collection: options.slug,
      data: {
        checksum,
        completedAt: new Date().toISOString(),
        documents: manifest.collections.reduce((sum, { count }) => sum + count, 0),
        files: manifest.media.reduce((sum, { files }) => sum + files, 0),
        manifest,
        size,
        status: 'completed',
      },
      overrideAccess: true,
    })) as unknown as BackupRecord

    payload.logger.info(`[payload-plugin-backup] Backup ${filename} completed (${size} bytes).`)

    await applyRetention({ options, payload }).catch((error: unknown) => {
      payload.logger.error({ err: error, msg: '[payload-plugin-backup] Retention cleanup failed' })
    })

    return completed
  } catch (error) {
    payload.logger.error({ err: error, msg: `[payload-plugin-backup] Backup ${filename} failed` })
    await payload.update({
      id: record.id,
      collection: options.slug,
      data: {
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        status: 'failed',
      },
      overrideAccess: true,
    })
    throw error
  } finally {
    await fsp.rm(workDir, { force: true, recursive: true })
  }
}
