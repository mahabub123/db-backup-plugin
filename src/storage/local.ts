import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'

import type { BackupStorageAdapter } from '../types.js'

import { assertSafeFilename } from '../utilities/filename.js'

export type LocalStorageAdapterArgs = {
  /**
   * Folder the archives are written to. Relative paths are resolved from the
   * current working directory. Keep it outside any publicly served folder.
   *
   * @default './backups'
   */
  directory?: string
}

/**
 * Keeps archives on the server's own disk. Fine for a single long-running
 * server; use a remote adapter (e.g. `s3StorageAdapter`) on serverless hosts
 * or when the backup must survive the loss of the server.
 */
export const localStorageAdapter = ({
  directory = './backups',
}: LocalStorageAdapterArgs = {}): BackupStorageAdapter => {
  const dir = path.resolve(directory)
  const resolve = (filename: string) => path.join(dir, assertSafeFilename(filename))

  return {
    name: 'local',
    delete: async ({ filename }) => {
      await fsp.rm(resolve(filename), { force: true })
    },
    download: async ({ filename }) => {
      const filePath = resolve(filename)
      await fsp.access(filePath)
      return fs.createReadStream(filePath)
    },
    list: async () => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.gz'))
        .map((entry) => ({ filename: entry.name }))
    },
    upload: async ({ filename, filePath }) => {
      await fsp.mkdir(dir, { recursive: true })
      await fsp.copyFile(filePath, resolve(filename))
    },
  }
}
