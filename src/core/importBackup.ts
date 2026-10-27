import type { Payload, TypedUser } from 'payload'
import type { Readable } from 'stream'

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { APIError } from 'payload'
import { pipeline } from 'stream/promises'
import * as tar from 'tar'

import type { BackupManifest, BackupType, SanitizedBackupPluginConfig } from '../types.js'
import type { BackupRecord } from './createBackup.js'

import { createBackupFilename } from '../utilities/filename.js'
import { checkCompatibility, type Compatibility } from './compatibility.js'
import { describeUser, sha256File } from './createBackup.js'

/**
 * Reads the manifest of an archive on disk and checks it can be restored on
 * this site. Throws a 400 APIError when the file isn't a backup at all.
 */
const inspectArchive = async ({
  archivePath,
  options,
  payload,
  workDir,
}: {
  archivePath: string
  options: SanitizedBackupPluginConfig
  payload: Payload
  workDir: string
}): Promise<{ manifest: BackupManifest } & Compatibility> => {
  const manifestDir = path.join(workDir, 'manifest')
  await fsp.mkdir(manifestDir, { recursive: true })
  try {
    await tar.extract({
      cwd: manifestDir,
      file: archivePath,
      filter: (entry) => path.normalize(entry) === 'manifest.json',
      strict: true,
    })
  } catch {
    throw new APIError('The file is not a valid .tar.gz backup archive.', 400)
  }

  let manifest: BackupManifest
  try {
    manifest = JSON.parse(
      await fsp.readFile(path.join(manifestDir, 'manifest.json'), 'utf8'),
    ) as BackupManifest
  } catch {
    throw new APIError('The file is not a Payload backup: manifest.json is missing.', 400)
  }

  return { manifest, ...checkCompatibility({ manifest, options, payload }) }
}

/** Creates the backups-collection record for an archive that is already in storage. */
const createRecord = async ({
  type,
  archivePath,
  filename,
  manifest,
  options,
  originalFilename,
  payload,
  user,
}: {
  archivePath: string
  filename: string
  manifest: BackupManifest
  options: SanitizedBackupPluginConfig
  originalFilename?: string
  payload: Payload
  type: BackupType
  user?: null | TypedUser
}): Promise<BackupRecord> => {
  const { size } = await fsp.stat(archivePath)
  const now = new Date().toISOString()
  return (await payload.create({
    collection: options.slug,
    data: {
      type,
      checksum: await sha256File(archivePath),
      completedAt: now,
      createdBy: describeUser(user),
      documents: manifest.collections.reduce((sum, { count }) => sum + count, 0),
      filename,
      files: manifest.media.reduce((sum, { files }) => sum + files, 0),
      importedFrom: originalFilename?.slice(0, 255),
      includesMedia: manifest.media.some(({ files }) => files > 0),
      manifest,
      size,
      // When the archive was made, not when it was found or imported.
      startedAt: manifest.createdAt ?? now,
      status: 'completed',
      storage: options.storage.name,
    },
    overrideAccess: true,
  })) as unknown as BackupRecord
}

const withWorkDir = async <T>(
  options: SanitizedBackupPluginConfig,
  prefix: string,
  run: (workDir: string) => Promise<T>,
): Promise<T> => {
  await fsp.mkdir(options.tempDir, { recursive: true })
  const workDir = await fsp.mkdtemp(path.join(options.tempDir, prefix))
  try {
    return await run(workDir)
  } finally {
    await fsp.rm(workDir, { force: true, recursive: true })
  }
}

/**
 * Stores an archive uploaded from elsewhere (another server, a downloaded
 * backup) so it shows up in the backups list and can be restored like any
 * other backup. Nothing is restored yet.
 */
export const importBackup = async ({
  options,
  originalFilename,
  payload,
  stream,
  user,
}: {
  options: SanitizedBackupPluginConfig
  /** Name of the uploaded file, kept for reference. */
  originalFilename?: string
  payload: Payload
  stream: Readable
  user?: null | TypedUser
}): Promise<{ backup: BackupRecord; warnings: Compatibility['warnings'] }> =>
  withWorkDir(options, 'payload-import-', async (workDir) => {
    const archivePath = path.join(workDir, 'upload.tar.gz')
    await pipeline(stream, fs.createWriteStream(archivePath))

    // Refuse archives that could never be restored here, before storing them.
    const { errors, manifest, warnings } = await inspectArchive({
      archivePath,
      options,
      payload,
      workDir,
    })
    if (errors.length) {
      throw new APIError(errors.join(' '), 400)
    }

    const filename = createBackupFilename()
    const { size } = await fsp.stat(archivePath)
    await options.storage.upload({ filename, filePath: archivePath, size })

    const backup = await createRecord({
      type: 'imported',
      archivePath,
      filename,
      manifest,
      options,
      originalFilename,
      payload,
      user,
    })
    return { backup, warnings }
  })

export type SyncResult = {
  /** Archives that were in storage but missing from the list, now added. */
  added: BackupRecord[]
  /** Archives in storage that can't be restored here, with the reason. */
  skipped: { filename: string; reason: string }[]
}

/**
 * Adds every archive found in storage that the backups list doesn't know
 * about. After losing a server or its database, install the plugin with the
 * same storage settings, run this, and restore the backup you need.
 */
export const syncFromStorage = async ({
  options,
  payload,
  user,
}: {
  options: SanitizedBackupPluginConfig
  payload: Payload
  user?: null | TypedUser
}): Promise<SyncResult> => {
  const { list } = options.storage
  if (!list) {
    throw new APIError(`The "${options.storage.name}" storage adapter cannot list its backups.`, 400)
  }

  const { docs } = await payload.find({
    collection: options.slug,
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    select: { filename: true },
  })
  const known = new Set(docs.map((doc) => doc.filename as string))
  const result: SyncResult = { added: [], skipped: [] }

  for (const { filename } of await list()) {
    if (known.has(filename)) {
      continue
    }
    await withWorkDir(options, 'payload-sync-', async (workDir) => {
      const archivePath = path.join(workDir, 'archive.tar.gz')
      await pipeline(await options.storage.download({ filename }), fs.createWriteStream(archivePath))
      try {
        const { errors, manifest } = await inspectArchive({ archivePath, options, payload, workDir })
        if (errors.length) {
          result.skipped.push({ filename, reason: errors.join(' ') })
          return
        }
        result.added.push(
          await createRecord({ type: 'found', archivePath, filename, manifest, options, payload, user }),
        )
      } catch (error) {
        result.skipped.push({ filename, reason: (error as Error).message })
      }
    })
  }

  return result
}
