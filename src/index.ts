import type { Config, Payload, TypedUser } from 'payload'

import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import type { VerificationResult } from './core/verify.js'
import type {
  BackupPluginConfig,
  BackupRecord,
  RestoreSummary,
  SanitizedBackupPluginConfig,
  ScheduleDefaults,
} from './types.js'

import { createBackupLockCollection } from './collections/BackupLock.js'
import { createBackupsCollection } from './collections/Backups.js'
import { createBackup as runBackup } from './core/createBackup.js'
import { getDatabaseKind, supportsTransactions } from './core/database.js'
import { INTERNAL_COLLECTIONS } from './core/entities.js'
import { getBackupHealth as runHealthCheck } from './core/health.js'
import { restoreBackup as runRestore } from './core/restoreBackup.js'
import { createGlobalRestoreGuard, createRestoreGuard } from './core/restoreGuard.js'
import { startScheduler } from './core/scheduler.js'
import { verifyBackup as runVerify } from './core/verify.js'
import { createBackupSettingsGlobal } from './globals/BackupSettings.js'
import { localStorageAdapter } from './storage/local.js'
import { CUSTOM_KEY, getOptions } from './utilities/getOptions.js'

export type { BackupHealth } from './core/health.js'
export { RESTORE_CONTEXT_KEY } from './core/restoreBackup.js'
export { runScheduledBackups } from './core/schedule.js'
export type { VerificationResult } from './core/verify.js'
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
export type { BackupRecord, RestoreSummary }


/**
 * `payload backup:export`, `backup:import`, `backup:sync` and `backup:verify`. The scripts sit next to
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
      { key: 'backup:verify', scriptPath: path.join(dir, `verify${ext}`) },
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
  verify: true,
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
    const slug = pluginOptions.slug ?? 'backups'
    if (pluginOptions.encryption && !pluginOptions.encryption.key) {
      throw new Error('payload-plugin-backup: `encryption.key` must not be empty.')
    }
    const options: SanitizedBackupPluginConfig = {
      slug,
      access:
        pluginOptions.access ??
        (({ req }) => Boolean(req.user && req.user.collection === adminUserSlug)),
      afterBackup: pluginOptions.afterBackup,
      afterBackupFailed: pluginOptions.afterBackupFailed,
      afterRestore: pluginOptions.afterRestore,
      batchSize: pluginOptions.batchSize ?? 500,
      blockWritesDuringRestore: pluginOptions.blockWritesDuringRestore ?? true,
      collections: {
        exclude: (pluginOptions.collections?.exclude) ?? [],
        include: pluginOptions.collections?.include,
      },
      encryption: pluginOptions.encryption
        ? {
            key: pluginOptions.encryption.key,
            previousKeys: pluginOptions.encryption.previousKeys ?? [],
          }
        : undefined,
      globals: {
        exclude: (pluginOptions.globals?.exclude) ?? [],
        include: pluginOptions.globals?.include,
      },
      healthGraceMinutes: Math.max(pluginOptions.healthGraceMinutes ?? 120, 0),
      includeVersions: pluginOptions.includeVersions ?? true,
      lockSlug: `${slug}-lock`,
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
      signing: {
        previousSecrets: pluginOptions.signing?.previousSecrets ?? [],
        secret: pluginOptions.signing?.secret,
      },
      storage: pluginOptions.storage ?? localStorageAdapter(),
      tempDir: pluginOptions.tempDir ?? os.tmpdir(),
      useTransaction: pluginOptions.useTransaction,
    }

    // The collection and global are added even when disabled so the database
    // schema (and migrations) stay the same whether or not the plugin is on.
    const adminGroup = pluginOptions.adminGroup ?? 'System'

    if (!disabled && options.blockWritesDuringRestore) {
      // Pause writes to everything a restore replaces. Preferences stay
      // writable so the admin panel keeps working while it waits.
      const skip = new Set(['payload-preferences', ...INTERNAL_COLLECTIONS])
      const collectionGuard = createRestoreGuard(options)
      const globalGuard = createGlobalRestoreGuard(options)
      config.collections = (config.collections ?? []).map((collection) =>
        skip.has(collection.slug)
          ? collection
          : {
              ...collection,
              hooks: {
                ...collection.hooks,
                beforeOperation: [...(collection.hooks?.beforeOperation ?? []), collectionGuard],
              },
            },
      )
      config.globals = (config.globals ?? []).map((global) => ({
        ...global,
        hooks: {
          ...global.hooks,
          beforeChange: [...(global.hooks?.beforeChange ?? []), globalGuard],
        },
      }))
    }

    config.collections = [
      ...(config.collections ?? []),
      createBackupsCollection({ adminGroup, disabled, options }),
      createBackupLockCollection({ options }),
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
      warnAboutSetup(payload, options)
    }

    return config
  }

/** Startup warnings for setups that look fine but don't protect the site well. */
const warnAboutSetup = (payload: Payload, options: SanitizedBackupPluginConfig) => {
  try {
    if (options.storage.name === 'local' && process.env.NODE_ENV === 'production') {
      payload.logger.warn(
        '[payload-plugin-backup] Backups are stored on this server\'s own disk; they are lost together with the server. Use s3StorageAdapter or r2StorageAdapter in production.',
      )
    }
    const kind = getDatabaseKind(payload)
    if (!supportsTransactions(payload)) {
      payload.logger.warn(
        `[payload-plugin-backup] The database adapter has no transactions, so a failing restore can leave the site half restored (the safety backup can undo it).${kind === 'sqlite' ? ' Set `transactionOptions: {}` in sqliteAdapter to make restores all-or-nothing.' : ''}`,
      )
    }
    if (kind === 'sqlite' || kind === 'other' || !supportsTransactions(payload)) {
      payload.logger.info(
        '[payload-plugin-backup] Backups on this database are not read from one consistent snapshot: documents changed while a backup runs may not match each other. Take backups when the site is quiet (the schedule runs at night by default).',
      )
    }
  } catch {
    // Warnings only.
  }
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
  args: {
    /** Restore an archive that isn't signed by this site. Only for archives you trust. */
    allowUnverified?: boolean
    user?: null | TypedUser
  } = {},
): Promise<{ safetyBackup?: BackupRecord; summary: RestoreSummary }> =>
  runRestore({ ...args, id, options: getOptions(payload), payload })

/**
 * Downloads a backup and checks it can be restored, without changing the
 * site. The result is saved on the backup.
 */
export const verifyBackup = (payload: Payload, id: number | string): Promise<VerificationResult> =>
  runVerify({ id, options: getOptions(payload), payload })

/** Whether scheduled backups are on time and healthy (what `GET /api/backups/health` returns). */
export const getBackupHealth = (payload: Payload) =>
  runHealthCheck({ options: getOptions(payload), payload })
