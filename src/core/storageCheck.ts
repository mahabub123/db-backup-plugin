import { APIError } from 'payload'

import type { SanitizedBackupPluginConfig } from '../types.js'

/**
 * Backups remember which storage adapter received them. After switching
 * storage (e.g. from the local folder to R2), older archives are still in the
 * old place; say so instead of failing with "not found".
 */
export const assertSameStorage = (
  backup: { filename: string; storage?: unknown },
  options: SanitizedBackupPluginConfig,
) => {
  if (typeof backup.storage === 'string' && backup.storage && backup.storage !== options.storage.name) {
    throw new APIError(
      `${backup.filename} was saved to "${backup.storage}" storage, but this site now uses "${options.storage.name}". Copy the file over and use "Import backup…", or switch the storage back.`,
      409,
    )
  }
}
