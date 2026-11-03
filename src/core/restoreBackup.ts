import type { Payload, PayloadRequest, TypedUser } from 'payload'

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import {
  APIError,
  commitTransaction,
  createLocalReq,
  initTransaction,
  killTransaction,
} from 'payload'
import { pipeline } from 'stream/promises'
import * as tar from 'tar'

import type {
  BackupManifest,
  BackupRecord,
  BackupType,
  RestoreSummary,
  SanitizedBackupPluginConfig,
} from '../types.js'

import { notify } from './callbacks.js'
import { checkCompatibility, checkMigrations } from './compatibility.js'
import { takeBackup } from './createBackup.js'
import {
  deferForeignKeys,
  getDatabaseKind,
  isTransactionTimeout,
  resetSequences,
  restoreForeignKeys,
} from './database.js'
import { getBackupCollections, getBackupGlobals, getMediaCollections } from './entities.js'
import { checkArchiveContents, isSignedBySite, openArchive, sha256File } from './integrity.js'
import { withLock } from './lock.js'
import {
  copyFileToStaticDir,
  fileExists,
  getArchiveMediaPath,
  getDocumentFiles,
  isLocalUploadCollection,
} from './media.js'
import { readNdjson } from './ndjson.js'
import { assertSameStorage } from './storageCheck.js'

export type { RestoreSummary }

/** Set on `req.context` while a restore writes to the database. */
export const RESTORE_CONTEXT_KEY = 'payloadPluginBackupRestore'

/** Backups this site made itself; their checksum in the database vouches for them. */
const LOCAL_TYPES: BackupType[] = ['manual', 'pre-restore', 'scheduled']

type StoredVersion = {
  autosave?: boolean
  createdAt: string
  parent?: number | string
  publishedLocale?: string
  snapshot?: true
  updatedAt: string
  version: Record<string, unknown>
}

const withoutID = ({ id: _id, ...rest }: Record<string, unknown>) => rest

export const readManifest = async (dir: string): Promise<BackupManifest> => {
  const manifestPath = path.join(dir, 'manifest.json')
  if (!(await fileExists(manifestPath))) {
    throw new Error('This file is not a Payload backup: manifest.json is missing.')
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as BackupManifest
  if (manifest.formatVersion !== 1) {
    throw new Error(`Unsupported backup format version: ${String(manifest.formatVersion)}`)
  }
  return manifest
}

/** Reads the manifest and throws if the archive cannot be restored on this site. */
const readRestorableManifest = async ({
  dir,
  options,
  payload,
}: {
  dir: string
  options: SanitizedBackupPluginConfig
  payload: Payload
}): Promise<BackupManifest> => {
  const manifest = await readManifest(dir)
  const { errors, warnings } = checkCompatibility({ manifest, options, payload })
  if (errors.length) {
    throw new APIError(errors.join(' '), 400)
  }
  for (const warning of [...warnings, ...(await checkMigrations({ manifest, payload }))]) {
    payload.logger.warn(`[payload-plugin-backup] ${warning}`)
  }
  return manifest
}

/**
 * Checks that an extracted archive is complete and unchanged, and that this
 * site made it. An archive that isn't signed by this site (made elsewhere,
 * before signing existed, or forged) is only restored with `allowUnverified`.
 */
export const assertTrustedArchive = async ({
  allowUnverified,
  backup,
  dir,
  manifest,
  options,
  payload,
}: {
  allowUnverified?: boolean
  backup?: BackupRecord
  dir: string
  manifest: BackupManifest
  options: SanitizedBackupPluginConfig
  payload: Payload
}): Promise<{ signed: boolean }> => {
  if (manifest.checksums) {
    const problems = await checkArchiveContents(dir, manifest.checksums)
    if (problems.length) {
      throw new APIError(
        `The backup is damaged or was changed: ${problems.slice(0, 5).join(' ')}${problems.length > 5 ? ` (${problems.length - 5} more)` : ''}`,
        400,
      )
    }
  }

  const signed = Boolean(manifest.checksums) && isSignedBySite(manifest, payload, options)
  const vouchedFor = Boolean(
    backup?.checksum && backup.type && LOCAL_TYPES.includes(backup.type),
  )
  if (!signed && !vouchedFor && !allowUnverified) {
    throw new APIError(
      'This backup is not signed by this site, so it cannot be verified: it was made by another site (or with another PAYLOAD_SECRET), by a plugin version before 1.2, or changed by someone else. Restore it only if you trust where it came from, by confirming that explicitly (allowUnverified).',
      400,
    )
  }
  return { signed }
}

const restoreDatabase = async ({
  afterWrite,
  dir,
  manifest,
  options,
  payload,
  req,
}: {
  /** Called after each document or version is written. */
  afterWrite: () => Promise<void>
  dir: string
  manifest: BackupManifest
  options: SanitizedBackupPluginConfig
  payload: Payload
  req: PayloadRequest
}): Promise<RestoreSummary> => {
  const summary: RestoreSummary = {
    collections: [],
    files: { failed: [], restored: 0, skipped: 0 },
    globals: [],
    skipped: [],
  }
  const collections = new Map(getBackupCollections(payload, options).map((c) => [c.slug, c]))
  const globals = new Map(getBackupGlobals(payload, options).map((g) => [g.slug, g]))
  const foreignKeys = await deferForeignKeys(payload, req)

  for (const entry of manifest.collections) {
    const collection = collections.get(entry.slug)
    if (!collection) {
      summary.skipped.push(entry.slug)
      continue
    }
    const { customIDType } = payload.collections[entry.slug]

    await payload.db.deleteMany({ collection: entry.slug, req, where: {} })

    let count = 0
    const docsFile = path.join(dir, 'collections', `${entry.slug}.ndjson`)
    if (await fileExists(docsFile)) {
      for await (const doc of readNdjson(docsFile)) {
        await payload.db.create({
          collection: entry.slug,
          customID: doc.id as number | string,
          data: customIDType ? doc : withoutID(doc),
          req,
          returning: false,
        })
        await afterWrite()
        count++
      }
    }

    let versions = 0
    const versionsFile = path.join(dir, 'versions', `${entry.slug}.ndjson`)
    if (collection.versions && (await fileExists(versionsFile))) {
      await payload.db.deleteVersions({ collection: entry.slug, req, where: {} })
      // Versions were exported oldest first, which keeps the `latest` flag right.
      for await (const version of readNdjson<StoredVersion>(versionsFile)) {
        await payload.db.createVersion({
          autosave: Boolean(version.autosave),
          collectionSlug: entry.slug,
          createdAt: version.createdAt,
          parent: version.parent as number | string,
          publishedLocale: version.publishedLocale,
          req,
          returning: false,
          snapshot: version.snapshot,
          updatedAt: version.updatedAt,
          versionData: withoutID(version.version),
        })
        await afterWrite()
        versions++
      }
    }

    summary.collections.push({ slug: entry.slug, count, versions })
  }

  for (const entry of manifest.globals) {
    const global = globals.get(entry.slug)
    if (!global) {
      if (entry.slug !== options.settingsSlug) {
        summary.skipped.push(entry.slug)
      }
      continue
    }

    const globalFile = path.join(dir, 'globals', `${entry.slug}.json`)
    if (entry.exists && (await fileExists(globalFile))) {
      const data = withoutID(JSON.parse(await fsp.readFile(globalFile, 'utf8')))
      const current = (await payload.db.findGlobal({ slug: entry.slug, req })) as
        | Record<string, unknown>
        | undefined
      if (current && Object.keys(current).length > 0) {
        await payload.db.updateGlobal({ slug: entry.slug, data, req, returning: false })
      } else {
        await payload.db.createGlobal({ slug: entry.slug, data, req, returning: false })
      }
      summary.globals.push(entry.slug)
    }

    const versionsFile = path.join(dir, 'global-versions', `${entry.slug}.ndjson`)
    if (global.versions && (await fileExists(versionsFile))) {
      await payload.db.deleteVersions({ globalSlug: entry.slug, req, where: {} })
      for await (const version of readNdjson<StoredVersion>(versionsFile)) {
        await payload.db.createGlobalVersion({
          autosave: Boolean(version.autosave),
          createdAt: version.createdAt,
          globalSlug: entry.slug,
          publishedLocale: version.publishedLocale,
          req,
          returning: false,
          snapshot: version.snapshot,
          updatedAt: version.updatedAt,
          versionData: withoutID(version.version),
        })
        await afterWrite()
      }
    }
  }

  await restoreForeignKeys(payload, req, foreignKeys)
  await resetSequences(payload, req)

  return summary
}

/**
 * Writes the uploaded files back. Runs after the database commit, so one file
 * that can't be written (full disk, bucket error) doesn't undo the restore:
 * it is listed in `summary.files.failed` instead.
 */
const restoreMedia = async ({
  dir,
  options,
  payload,
  summary,
}: {
  dir: string
  options: SanitizedBackupPluginConfig
  payload: Payload
  summary: RestoreSummary
}) => {
  for (const collection of getMediaCollections(payload, options)) {
    const docsFile = path.join(dir, 'collections', `${collection.slug}.ndjson`)
    if (!(await fileExists(docsFile))) {
      continue
    }

    for await (const doc of readNdjson(docsFile)) {
      for (const file of getDocumentFiles(doc)) {
        const source = getArchiveMediaPath(dir, collection.slug, file)
        if (!(await fileExists(source))) {
          continue
        }

        try {
          if (isLocalUploadCollection(collection)) {
            await copyFileToStaticDir({ collection, file, source })
            summary.files.restored++
          } else if (options.media.restoreFile) {
            await options.media.restoreFile({
              collection: collection.slug,
              doc,
              filename: file.filename,
              filePath: source,
              payload,
              prefix: file.prefix,
            })
            summary.files.restored++
          } else {
            summary.files.skipped++
          }
        } catch (error) {
          summary.files.failed.push({
            file: [collection.slug, file.prefix, file.filename].filter(Boolean).join('/'),
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  if (summary.files.skipped) {
    payload.logger.warn(
      `[payload-plugin-backup] ${summary.files.skipped} file(s) belong to upload collections with disableLocalStorage and were not restored. Provide \`media.restoreFile\` to upload them to your storage.`,
    )
  }
  if (summary.files.failed.length) {
    payload.logger.error(
      `[payload-plugin-backup] ${summary.files.failed.length} file(s) could not be restored, e.g. ${summary.files.failed[0].file}: ${summary.files.failed[0].reason}`,
    )
  }
}

/**
 * Replaces the content of the site with the content of an extracted archive.
 * The database part runs in one transaction (when the adapter supports it),
 * so a failing restore leaves the database as it was. Files are written after
 * the database commit.
 */
export const restoreFromDirectory = async ({
  dir,
  options,
  payload,
  user,
}: {
  dir: string
  options: SanitizedBackupPluginConfig
  payload: Payload
  user?: null | TypedUser
}): Promise<RestoreSummary> => {
  const manifest = await readRestorableManifest({ dir, options, payload })
  const isMongo = getDatabaseKind(payload) === 'mongodb'

  /**
   * `single`: one transaction for the whole restore, all or nothing.
   * `batches`: commit every `batchSize` writes, for MongoDB databases too large
   * for one transaction. Much faster than committing every write on its own.
   */
  const restoreOnce = async (mode: 'batches' | 'single'): Promise<RestoreSummary> => {
    const req = await createLocalReq(
      { context: { [RESTORE_CONTEXT_KEY]: true }, user: user ?? undefined },
      payload,
    )
    let open = await initTransaction(req)
    if (!open) {
      payload.logger.warn(
        '[payload-plugin-backup] The database adapter has no transactions, so a failing restore can leave the site half restored (use the safety backup to undo it). On SQLite, set `transactionOptions: {}` in sqliteAdapter.',
      )
    }
    let writes = 0
    const afterWrite = async () => {
      if (mode === 'batches' && open && ++writes % options.batchSize === 0) {
        await commitTransaction(req)
        open = await initTransaction(req)
      }
    }

    try {
      const summary = await restoreDatabase({ afterWrite, dir, manifest, options, payload, req })
      if (open) {
        await commitTransaction(req)
      }
      return summary
    } catch (error) {
      if (open) {
        await killTransaction(req).catch(() => undefined)
      }
      throw error
    }
  }

  let summary: RestoreSummary
  try {
    // Foreign keys can only be postponed inside a transaction on SQL databases.
    summary = await restoreOnce(isMongo && options.useTransaction === false ? 'batches' : 'single')
  } catch (error) {
    if (!isMongo || options.useTransaction === false || !isTransactionTimeout(error)) {
      throw error
    }
    if (options.useTransaction === true) {
      throw new Error(
        'MongoDB ended the restore transaction because it ran longer than 60 seconds. Nothing was changed. Set `useTransaction: false` in the backup plugin options (or leave it unset) to restore large databases.',
        { cause: error },
      )
    }
    // The transaction was rolled back, so nothing changed yet. Restore again in
    // smaller transactions; the safety backup taken before the restore can undo it.
    payload.logger.warn(
      '[payload-plugin-backup] MongoDB ended the restore transaction after 60 seconds (large database). Nothing was changed; restoring again in smaller transactions.',
    )
    summary = await restoreOnce('batches')
  }

  await restoreMedia({ dir, options, payload, summary })

  return summary
}

/**
 * Unpacks a plain `.tar.gz` into a fresh folder. Only regular files and
 * folders are unpacked: a symlink or hard link in an archive could otherwise
 * make the restore read files from elsewhere on the server.
 * node-tar also strips absolute paths and `..` segments.
 */
export const extractArchive = async ({
  archivePath,
  dir,
}: {
  archivePath: string
  dir: string
}): Promise<void> => {
  await fsp.mkdir(dir, { recursive: true })
  await tar.extract({
    cwd: dir,
    file: archivePath,
    filter: (_path, entry) => {
      const type = (entry as { type?: string }).type
      return type === 'File' || type === 'OldFile' || type === 'Directory'
    },
    strict: true,
  })
}

/**
 * Downloads (when needed), checks, decrypts and unpacks a stored backup into
 * `workDir/data`. Shared by restore and verify.
 */
export const unpackStoredBackup = async ({
  backup,
  options,
  workDir,
}: {
  backup: BackupRecord
  options: SanitizedBackupPluginConfig
  workDir: string
}): Promise<string> => {
  const archivePath = path.join(workDir, 'archive')
  await pipeline(
    await options.storage.download({ filename: backup.filename }),
    fs.createWriteStream(archivePath),
  )

  if (backup.checksum && (await sha256File(archivePath)) !== backup.checksum) {
    throw new Error(`Backup ${backup.filename} is corrupted: its checksum does not match.`)
  }

  const { tarPath } = await openArchive({ archivePath, options })
  const dataDir = path.join(workDir, 'data')
  await extractArchive({ archivePath: tarPath, dir: dataDir })
  // Free the disk space of the archive before the restore needs more.
  await fsp.rm(archivePath, { force: true })
  await fsp.rm(tarPath, { force: true })
  return dataDir
}

export type RestoreBackupArgs = {
  /** Restore an archive that isn't signed by this site. Only for archives you trust. */
  allowUnverified?: boolean
  id: number | string
  options: SanitizedBackupPluginConfig
  payload: Payload
  user?: null | TypedUser
}

/**
 * Restores a stored backup. Unless `safetyBackupBeforeRestore` is turned off,
 * the current state is backed up first, so the restore can be undone.
 * Throws a 409 APIError while another backup or restore is running on any server.
 */
export const restoreBackup = (
  args: RestoreBackupArgs,
): Promise<{ safetyBackup?: BackupRecord; summary: RestoreSummary }> =>
  withLock({ options: args.options, payload: args.payload, task: 'restore' }, () => runRestore(args))

const runRestore = async ({
  id,
  allowUnverified,
  options,
  payload,
  user,
}: RestoreBackupArgs): Promise<{ safetyBackup?: BackupRecord; summary: RestoreSummary }> => {
  const backup = (await payload.findByID({
    id,
    collection: options.slug,
    depth: 0,
    overrideAccess: true,
  })) as unknown as BackupRecord

  if (backup.status !== 'completed') {
    throw new Error(`Backup ${backup.filename} is not complete and cannot be restored.`)
  }
  assertSameStorage(backup, options)

  await fsp.mkdir(options.tempDir, { recursive: true })
  const workDir = await fsp.mkdtemp(path.join(options.tempDir, 'payload-restore-'))

  let started = false
  try {
    const dataDir = await unpackStoredBackup({ backup, options, workDir })
    // Fail before the safety backup if the archive doesn't fit this site or can't be trusted.
    const manifest = await readRestorableManifest({ dir: dataDir, options, payload })
    await assertTrustedArchive({ allowUnverified, backup, dir: dataDir, manifest, options, payload })

    const safetyBackup = options.safetyBackupBeforeRestore
      ? await takeBackup({
          type: 'pre-restore',
          includeMedia: Boolean(backup.includesMedia),
          options,
          payload,
          user,
        })
      : undefined

    payload.logger.info(`[payload-plugin-backup] Restoring ${backup.filename}...`)
    started = true
    const summary = await restoreFromDirectory({ dir: dataDir, options, payload, user })

    await payload.update({
      id,
      collection: options.slug,
      data: { restoredAt: new Date().toISOString() },
      overrideAccess: true,
    })

    payload.logger.info(`[payload-plugin-backup] Restored ${backup.filename}.`)
    await notify(payload, 'afterRestore', () => options.afterRestore?.({ backup, payload, summary }))
    return { safetyBackup, summary }
  } catch (error) {
    if (started) {
      payload.logger.error({ err: error, msg: `[payload-plugin-backup] Restore of ${backup.filename} failed` })
    }
    await notify(payload, 'afterRestore', () => options.afterRestore?.({ backup, error, payload }))
    throw error
  } finally {
    await fsp.rm(workDir, { force: true, recursive: true })
  }
}
