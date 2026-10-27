import type { Payload } from 'payload'

import type { SanitizedBackupPluginConfig } from '../types.js'

/** Where the resolved plugin options live on `config.custom`. */
export const CUSTOM_KEY = 'payloadPluginBackup'

export const getOptions = (payload: Payload): SanitizedBackupPluginConfig => {
  const options = (payload.config.custom as Record<string, unknown> | undefined)?.[CUSTOM_KEY]
  if (!options) {
    throw new Error('payload-plugin-backup is not installed or is disabled in this Payload config.')
  }
  return options as SanitizedBackupPluginConfig
}
