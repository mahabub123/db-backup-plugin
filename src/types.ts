import type { CollectionSlug, GlobalSlug, Payload, PayloadRequest } from 'payload'
import type { Readable } from 'stream'

/**
 * Where backup archives are kept. Implement this to send backups anywhere
 * (S3, R2, Google Cloud Storage, an SFTP server, ...).
 */
export type BackupStorageAdapter = {
  /** Remove an archive. Must not throw if the archive no longer exists. */
  delete: (args: { filename: string }) => Promise<void>
  /** Return a readable stream of the archive. */
  download: (args: { filename: string }) => Promise<Readable>
  /**
   * List the archives in storage. Optional, but needed to find backups again
   * after the database is lost ("Find backups in storage").
   */
  list?: () => Promise<{ filename: string; size?: number }[]>
  /** Shown in the admin panel next to each backup. */
  name: string
  /** Store the archive located at `filePath` under `filename`. */
  upload: (args: { filename: string; filePath: string; size: number }) => Promise<void>
}

export type RestoreMediaFileArgs = {
  collection: CollectionSlug
  /** The upload document the file belongs to, as stored in the backup. */
  doc: Record<string, unknown>
  filename: string
  /** Absolute path of the extracted file on local disk. */
  filePath: string
  payload: Payload
  prefix?: string
}

export type BackupPluginConfig = {
  /**
   * Who may list, create, download, restore and delete backups.
   * Archives contain every document of the site, including password hashes,
   * so restrict this to your most trusted administrators.
   *
   * @default only signed-in users of the admin user collection
   */
  access?: (args: { req: PayloadRequest }) => boolean | Promise<boolean>
  /** Admin panel group the backups collection is shown in. @default 'System' */
  adminGroup?: string
  /** Number of documents read from / written to the database per batch. @default 500 */
  batchSize?: number
  /** Which collections end up in the archive. */
  collections?: {
    /** Collections to leave out, on top of the plugin's internal ones. */
    exclude?: CollectionSlug[]
    /** When set, only these collections are backed up. */
    include?: CollectionSlug[]
  }
  /**
   * Turns the plugin off without uninstalling it. The backups collection is
   * kept so the database schema (and migrations) stay consistent.
   */
  disabled?: boolean
  /** Which globals end up in the archive. */
  globals?: {
    exclude?: GlobalSlug[]
    include?: GlobalSlug[]
  }
  /** Back up the version history of collections and globals. @default true */
  includeVersions?: boolean
  /**
   * Back up the files of upload collections.
   * Files on local disk are copied directly; files kept by a cloud storage
   * adapter are read through the adapter's static handler.
   *
   * @default true
   */
  media?:
    | {
        /** When set, only files of these upload collections are backed up. */
        collections?: CollectionSlug[]
        /**
         * Called for every file during a restore when the upload collection has
         * `disableLocalStorage: true` (e.g. S3/R2 through a storage adapter).
         * Upload the file back to your bucket here. Without it, such files are
         * skipped during restore and a warning is logged.
         */
        restoreFile?: (args: RestoreMediaFileArgs) => Promise<void>
      }
    | boolean
  /**
   * Delete old manual, imported and before-restore backups automatically.
   * Scheduled backups have their own "keep" counts in Backup Settings.
   */
  retention?: {
    /** Delete completed backups older than this many days. */
    maxAgeDays?: number
    /** Keep at most this many completed backups. */
    maxBackups?: number
  }
  /**
   * Take an automatic backup of the current state right before a restore,
   * so a restore can always be undone.
   *
   * @default true
   */
  safetyBackupBeforeRestore?: boolean
  /**
   * Automatic daily / weekly / monthly backups. Turn them on and pick the
   * times under System → Backup Settings in the admin panel; `defaults` only
   * sets the initial values of those settings.
   *
   * Pass `false` to remove the scheduler (the settings global stays, so the
   * database schema doesn't change).
   */
  schedule?:
    | {
        /**
         * Lets an external cron (Vercel Cron, GitHub Actions, cron-job.org, ...)
         * trigger `GET /api/<slug>/cron` with `Authorization: Bearer <cronSecret>`.
         * Use this on serverless hosts, where a timer can't run.
         */
        cronSecret?: string
        /** Initial values for the Backup Settings global. */
        defaults?: Partial<ScheduleDefaults>
        /** How often the server checks whether a backup is due, in minutes. @default 5 */
        intervalMinutes?: number
        /**
         * Check for due backups from a timer inside the Payload server process.
         * Turn off on serverless hosts and when several server instances run
         * (use `cronSecret` with one external cron instead).
         *
         * @default true
         */
        runOnServer?: boolean
      }
    | false
  /** Slug of the global holding the automatic backup settings. @default 'backup-settings' */
  settingsSlug?: string
  /** Slug of the collection that tracks backups. @default 'backups' */
  slug?: string
  /** Where archives are stored. @default localStorageAdapter({ directory: './backups' }) */
  storage?: BackupStorageAdapter
  /** Directory used while building and extracting archives. @default os.tmpdir() */
  tempDir?: string
  /**
   * Run the database part of a restore in a single transaction so a failed
   * restore leaves the database untouched. Turn off for very large MongoDB
   * databases that exceed MongoDB's 60 second transaction limit.
   *
   * @default true
   */
  useTransaction?: boolean
}

export type BackupType = 'found' | 'imported' | 'manual' | 'pre-restore' | 'scheduled'

export type BackupFrequency = 'daily' | 'monthly' | 'weekly'

export type ScheduleDefaults = {
  daily: { enabled: boolean; keep: number }
  /** Automatic backups on or off. */
  enabled: boolean
  includeMedia: boolean
  /** `day` is the day of the month; in shorter months the last day is used. */
  monthly: { day: number; enabled: boolean; keep: number }
  /** 24h clock, e.g. "03:00". */
  time: string
  /** IANA name, e.g. "Europe/London", "Asia/Dhaka". */
  timezone: string
  weekly: {
    day: 'friday' | 'monday' | 'saturday' | 'sunday' | 'thursday' | 'tuesday' | 'wednesday'
    enabled: boolean
    keep: number
  }
}

export type BackupStatus = 'completed' | 'failed' | 'running'

/** The resolved options every part of the plugin works with. */
export type SanitizedBackupPluginConfig = {
  access: (args: { req: PayloadRequest }) => boolean | Promise<boolean>
  batchSize: number
  collections: { exclude: string[]; include?: string[] }
  globals: { exclude: string[]; include?: string[] }
  includeVersions: boolean
  media: {
    collections?: string[]
    enabled: boolean
    restoreFile?: (args: RestoreMediaFileArgs) => Promise<void>
  }
  retention?: { maxAgeDays?: number; maxBackups?: number }
  safetyBackupBeforeRestore: boolean
  schedule: {
    cronSecret?: string
    defaults: ScheduleDefaults
    enabled: boolean
    intervalMinutes: number
    runOnServer: boolean
  }
  settingsSlug: string
  slug: string
  storage: BackupStorageAdapter
  tempDir: string
  useTransaction: boolean
}

export type BackupManifest = {
  collections: {
    count: number
    slug: string
    versions: number
  }[]
  createdAt: string
  databaseAdapter: string
  /** Archive layout version, bumped on breaking changes. */
  formatVersion: 1
  globals: {
    exists: boolean
    slug: string
    versions: number
  }[]
  media: {
    collection: string
    files: number
    missing: string[]
  }[]
  payloadVersion: string
  pluginVersion: string
}
