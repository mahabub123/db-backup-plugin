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

import type { BackupManifest, SanitizedBackupPluginConfig } from '../types.js'
import type { BackupRecord } from './createBackup.js'

import { checkCompatibility } from './compatibility.js'
import { createBackup, sha256File } from './createBackup.js'
import { deferForeignKeys, getDatabaseKind, resetSequences, restoreForeignKeys } from './database.js'
import { getBackupCollections, getBackupGlobals, getMediaCollections } from './entities.js'
import {
  copyFileToStaticDir,
  fileExists,
  getArchiveMediaPath,
  getDocumentFiles,
  isLocalUploadCollection,
} from './media.js'
import { readNdjson } from './ndjson.js'
import { assertSameStorage } from './storageCheck.js'

/** Set on `req.context` while a restore writes to the database. */
export const RESTORE_CONTEXT_KEY = 'payloadPluginBackupRestore'

export type RestoreSummary = {
  collections: { count: number; slug: string; versions: number }[]
  files: { restored: number; skipped: number }
  globals: string[]
  /** Collections/globals in the archive that no longer exist in this config. */
  skipped: string[]
}

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

const readManifest = async (dir: string): Promise<BackupManifest> => {
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
  for (const warning of warnings) {
    payload.logger.warn(`[payload-plugin-backup] ${warning}`)
  }
  return manifest
}

const restoreDatabase = async ({
  dir,
  manifest,
  options,
  payload,
  req,
}: {
  dir: string
  manifest: BackupManifest
  options: SanitizedBackupPluginConfig
  payload: Payload
  req: PayloadRequest
}): Promise<RestoreSummary> => {
  const summary: RestoreSummary = {
    collections: [],
    files: { restored: 0, skipped: 0 },
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
        versions++
      }
    }

    summary.collections.push({ slug: entry.slug, count, versions })
  }

  for (const entry of manifest.globals) {
    const global = globals.get(entry.slug)
    if (!global) {
      summary.skipped.push(entry.slug)
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
      }
    }
  }

  await restoreForeignKeys(payload, req, foreignKeys)
  await resetSequences(payload, req)

  return summary
}

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
      }
    }
  }

  if (summary.files.skipped) {
    payload.logger.warn(
      `[payload-plugin-backup] ${summary.files.skipped} file(s) belong to upload collections with disableLocalStorage and were not restored. Provide \`media.restoreFile\` to upload them to your storage.`,
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
  const req = await createLocalReq(
    { context: { [RESTORE_CONTEXT_KEY]: true }, user: user ?? undefined },
    payload,
  )

  // Foreign keys can only be postponed inside a transaction on SQL databases.
  const useTransaction = options.useTransaction || getDatabaseKind(payload) !== 'mongodb'
  const shouldCommit = useTransaction ? await initTransaction(req) : false

  let summary: RestoreSummary
  try {
    summary = await restoreDatabase({ dir, manifest, options, payload, req })
    if (shouldCommit) {
      await commitTransaction(req)
    }
  } catch (error) {
    if (shouldCommit) {
      await killTransaction(req)
    }
    throw error
  }

  await restoreMedia({ dir, options, payload, summary })

  return summary
}

/** Downloads and unpacks an archive into a fresh temporary folder. */
export const extractArchive = async ({
  archivePath,
  dir,
}: {
  archivePath: string
  dir: string
}): Promise<void> => {
  await fsp.mkdir(dir, { recursive: true })
  // node-tar strips absolute paths and `..` segments, so entries stay inside `dir`.
  await tar.extract({ cwd: dir, file: archivePath, strict: true })
}

export type RestoreBackupArgs = {
  id: number | string
  options: SanitizedBackupPluginConfig
  payload: Payload
  user?: null | TypedUser
}

/**
 * Restores a stored backup. Unless `safetyBackupBeforeRestore` is turned off,
 * the current state is backed up first, so the restore can be undone.
 */
export const restoreBackup = async ({
  id,
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

  try {
    const archivePath = path.join(workDir, 'archive.tar.gz')
    await pipeline(
      await options.storage.download({ filename: backup.filename }),
      fs.createWriteStream(archivePath),
    )

    if (backup.checksum && (await sha256File(archivePath)) !== backup.checksum) {
      throw new Error(`Backup ${backup.filename} is corrupted: its checksum does not match.`)
    }

    const dataDir = path.join(workDir, 'data')
    await extractArchive({ archivePath, dir: dataDir })
    // Fail before the safety backup if the archive doesn't fit this site.
    await readRestorableManifest({ dir: dataDir, options, payload })

    const safetyBackup = options.safetyBackupBeforeRestore
      ? await createBackup({
          type: 'pre-restore',
          includeMedia: Boolean(backup.includesMedia),
          options,
          payload,
          user,
        })
      : undefined

    payload.logger.info(`[payload-plugin-backup] Restoring ${backup.filename}...`)
    const summary = await restoreFromDirectory({ dir: dataDir, options, payload, user })

    await payload.update({
      id,
      collection: options.slug,
      data: { restoredAt: new Date().toISOString() },
      overrideAccess: true,
    })

    payload.logger.info(`[payload-plugin-backup] Restored ${backup.filename}.`)
    return { safetyBackup, summary }
  } finally {
    await fsp.rm(workDir, { force: true, recursive: true })
  }
}
