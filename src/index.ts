import type { Config, Payload, TypedUser } from 'payload'

import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import type { BackupRecord } from './core/createBackup.js'
import type { RestoreSummary } from './core/restoreBackup.js'
import type { BackupPluginConfig, SanitizedBackupPluginConfig, ScheduleDefaults } from './types.js'

import { createBackupsCollection } from './collections/Backups.js'
import { createBackup as runBackup } from './core/createBackup.js'
import { restoreBackup as runRestore } from './core/restoreBackup.js'
import { startScheduler } from './core/scheduler.js'
import { createBackupSettingsGlobal } from './globals/BackupSettings.js'
import { localStorageAdapter } from './storage/local.js'
import { CUSTOM_KEY, getOptions } from './utilities/getOptions.js'

export { RESTORE_CONTEXT_KEY } from './core/restoreBackup.js'
export type { RestoreSummary } from './core/restoreBackup.js'
export { runScheduledBackups } from './core/schedule.js'
export { localStorageAdapter } from './storage/local.js'
export type { LocalStorageAdapterArgs } from './storage/local.js'
export { r2StorageAdapter, s3StorageAdapter } from './storage/s3.js'
export type { R2StorageAdapterArgs, S3StorageAdapterArgs } from './storage/s3.js'
export type {
  BackupFrequency,
  BackupManifest,
  BackupPluginConfig,
  BackupStorageAdapter,
  BackupType,
  RestoreMediaFileArgs,
} from './types.js'
export type { BackupRecord }


/**
 * `payload backup:export`, `backup:import` and `backup:sync`. The scripts sit next to
 * this file (src/*.ts while developing, dist/*.js once published).
 */
const getBinScripts = () => {
  try {
    const file = fileURLToPath(import.meta.url)
    const dir = path.join(path.dirname(file), 'bin')
    const ext = path.extname(file)
    return [
      { key: 'backup:export', scriptPath: path.join(dir, `export${ext}`) },
      { key: 'backup:import', scriptPath: path.join(dir, `import${ext}`) },
      { key: 'backup:sync', scriptPath: path.join(dir, `sync${ext}`) },
    ]
  } catch {
    // Bundled environments may not expose a file URL; the CLI doesn't run there.
    return []
  }
}

const DEFAULT_SCHEDULE: ScheduleDefaults = {
  daily: { enabled: true, keep: 7 },
  enabled: false,
  includeMedia: true,
  monthly: { day: 1, enabled: true, keep: 12 },
  time: '03:00',
  timezone: 'UTC',
  weekly: { day: 'sunday', enabled: true, keep: 4 },
}

/**
 * Backs up the whole site: every collection and global (with version history)
 * and every uploaded file, as one portable `.tar.gz` archive.
 *
 * Adds a "Backups" collection to the admin panel to create, export, import
 * and restore backups, a "Backup Settings" page for automatic daily, weekly
 * and monthly backups, REST endpoints and `payload backup:*` commands.
 */
export const backupPlugin =
  (pluginOptions: BackupPluginConfig = {}) =>
  (incomingConfig: Config): Config => {
    const config = { ...incomingConfig }
    const disabled = Boolean(pluginOptions.disabled)

    // Payload falls back to the first auth collection when admin.user is not set.
    const adminUserSlug =
      config.admin?.user ?? config.collections?.find((collection) => collection.auth)?.slug

    const media = pluginOptions.media ?? true
    const schedule = pluginOptions.schedule || undefined
    const options: SanitizedBackupPluginConfig = {
      slug: pluginOptions.slug ?? 'backups',
      access:
        pluginOptions.access ??
        (({ req }) => Boolean(req.user && req.user.collection === adminUserSlug)),
      batchSize: pluginOptions.batchSize ?? 500,
      collections: {
        exclude: (pluginOptions.collections?.exclude) ?? [],
        include: pluginOptions.collections?.include,
      },
      globals: {
        exclude: (pluginOptions.globals?.exclude) ?? [],
        include: pluginOptions.globals?.include,
      },
      includeVersions: pluginOptions.includeVersions ?? true,
      media: {
        collections:
          typeof media === 'object' ? (media.collections) : undefined,
        enabled: media !== false,
        restoreFile: typeof media === 'object' ? media.restoreFile : undefined,
      },
      retention: pluginOptions.retention,
      safetyBackupBeforeRestore: pluginOptions.safetyBackupBeforeRestore ?? true,
      schedule: {
        cronSecret: schedule ? schedule.cronSecret : undefined,
        defaults: {
          ...DEFAULT_SCHEDULE,
          ...schedule?.defaults,
          daily: { ...DEFAULT_SCHEDULE.daily, ...schedule?.defaults?.daily },
          monthly: { ...DEFAULT_SCHEDULE.monthly, ...schedule?.defaults?.monthly },
          weekly: { ...DEFAULT_SCHEDULE.weekly, ...schedule?.defaults?.weekly },
        },
        enabled: pluginOptions.schedule !== false,
        intervalMinutes: Math.max(schedule?.intervalMinutes ?? 5, 1),
        runOnServer: schedule ? schedule.runOnServer !== false : true,
      },
      settingsSlug: pluginOptions.settingsSlug ?? 'backup-settings',
      storage: pluginOptions.storage ?? localStorageAdapter(),
      tempDir: pluginOptions.tempDir ?? os.tmpdir(),
      useTransaction: pluginOptions.useTransaction ?? true,
    }

    // The collection and global are added even when disabled so the database
    // schema (and migrations) stay the same whether or not the plugin is on.
    const adminGroup = pluginOptions.adminGroup ?? 'System'
    config.collections = [
      ...(config.collections ?? []),
      createBackupsCollection({ adminGroup, disabled, options }),
    ]
    config.globals = [
      ...(config.globals ?? []),
      createBackupSettingsGlobal({ adminGroup, disabled, options }),
    ]

    if (disabled) {
      return config
    }

    config.custom = { ...config.custom, [CUSTOM_KEY]: options }

    config.bin = [...(config.bin ?? []), ...getBinScripts()]

    const incomingOnInit = config.onInit
    config.onInit = async (payload) => {
      if (incomingOnInit) {
        await incomingOnInit(payload)
      }
      startScheduler(payload, options)
    }

    return config
  }

/**
 * Takes a backup from your own code (scripts, hooks, custom endpoints):
 *
 * ```ts
 * const backup = await createBackup(payload)
 * ```
 */
export const createBackup = (
  payload: Payload,
  args: { includeMedia?: boolean; user?: null | TypedUser } = {},
): Promise<BackupRecord> => runBackup({ ...args, options: getOptions(payload), payload })

/**
 * Restores a backup from your own code. This replaces all content of the site.
 *
 * ```ts
 * await restoreBackup(payload, backupId)
 * ```
 */
export const restoreBackup = (
  payload: Payload,
  id: number | string,
  args: { user?: null | TypedUser } = {},
): Promise<{ safetyBackup?: BackupRecord; summary: RestoreSummary }> =>
  runRestore({ ...args, id, options: getOptions(payload), payload })
