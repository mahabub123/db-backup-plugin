# payload-plugin-backup

Back up and restore an **entire Payload CMS website** (every collection, global, draft, version, user and uploaded file) from the admin panel, the REST API, your own code or on a schedule.

Built for Payload 3 following the official [Build your own plugin](https://payloadcms.com/docs/plugins/build-your-own) guide. Tested against MongoDB, Postgres and SQLite.

## What a backup contains

Each backup is a single `.tar.gz` archive:

```
manifest.json                  what is inside, Payload + plugin versions, counts
collections/<slug>.ndjson      every document, exactly as stored (ids, password hashes, all locales)
versions/<slug>.ndjson         drafts and version history
globals/<slug>.json
global-versions/<slug>.ndjson
media/<collection>/<file>      original uploads + every generated image size
```

Documents are read and written through Payload's database adapter, not the Local API. Hooks and access control don't interfere, and hidden fields such as password hashes are kept. IDs are preserved, so relationships, uploads and drafts all line up after a restore.

These collections are never backed up or overwritten: the backups collection itself, `payload-jobs`, `payload-locked-documents` and `payload-migrations` (migrations describe the current schema, not the archived one).

## Install

```bash
pnpm add payload-plugin-backup
```

```ts
// payload.config.ts
import { backupPlugin } from 'payload-plugin-backup'

export default buildConfig({
  // ...
  plugins: [
    backupPlugin({
      // Only admins should be able to download a copy of your whole database.
      access: ({ req }) => req.user?.role === 'admin',
    }),
  ],
})
```

Then regenerate the import map and types, and create a migration if you use Postgres or SQLite migrations:

```bash
pnpm payload generate:importmap
pnpm payload generate:types
pnpm payload migrate:create add_backups
```

**Backups** and **Backup Settings** now appear under **System** in the admin panel.

## Export and import

Use these to keep a copy of your site on your own computer, or to move a site to another server (local → production, old host → new host).

**Export** (download a backup as a `.tar.gz` file):

- **Export new backup** at the top of the Backups list creates a fresh backup and downloads it straight away.
- The **Export** link on every row downloads that backup.
- **Export (download .tar.gz)** does the same from inside a backup.

**Import** (upload a `.tar.gz` file, from this site or another one):

- **Import backup…** at the top of the Backups list uploads the file.
- The file is checked before it is accepted. It must be a backup made by this plugin, from the same kind of database (MongoDB, Postgres or SQLite).
- Then you choose **Restore now** (type `RESTORE` to confirm) or **Keep for later**. A kept import shows in the list as type *Imported* and can be restored at any time.
- You are warned when the backup contains collections or globals this site no longer has. Those are skipped; everything else is restored.

Every restore, from the list, a backup or an import, first takes a safety backup of the current state (type *Before restore*), so it can be undone.

### From the command line

Very large sites can hit browser upload limits or server request timeouts. Run export and import directly on the server instead:

```bash
# create a new backup and save it to a file
pnpm payload backup:export ./site-2026-10-27.tar.gz
pnpm payload backup:export ./db-only.tar.gz --no-media
pnpm payload backup:export ./copy.tar.gz --id 12        # export an existing backup

# add a file to the backups list...
pnpm payload backup:import ./site-2026-10-27.tar.gz
# ...or add it and restore it right away (asks you to type RESTORE)
pnpm payload backup:import ./site-2026-10-27.tar.gz --restore
pnpm payload backup:import ./site-2026-10-27.tar.gz --restore --yes   # no prompt, for scripts

# add everything in the bucket that is missing from the list (after losing the database)
pnpm payload backup:sync
```

Moving a site to a new server:

```bash
# old server
pnpm payload backup:export ./site.tar.gz
# copy site.tar.gz to the new server (scp, rsync, bucket...), deploy the same code, run migrations, then:
pnpm payload backup:import ./site.tar.gz --restore
```

## Automatic backups (daily, weekly, monthly) to S3 or R2

### 1. Store backups in a bucket

Backups on the same disk as the site don't survive losing the server, so send them to a **private** bucket.

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage   # lib-storage: multipart uploads for archives > 100 MB
```

**Cloudflare R2**: in the Cloudflare dashboard, create a bucket, then *R2 → Manage API tokens → Create API token* with **Object Read & Write** on that bucket.

```ts
import { backupPlugin, r2StorageAdapter } from 'payload-plugin-backup'

backupPlugin({
  access: ({ req }) => req.user?.role === 'admin',
  storage: r2StorageAdapter({
    accountId: process.env.R2_ACCOUNT_ID!,
    bucket: process.env.R2_BACKUP_BUCKET!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    prefix: 'production', // folder inside the bucket
  }),
})
```

**AWS S3** (or Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi, any S3-compatible service):

```ts
import { backupPlugin, s3StorageAdapter } from 'payload-plugin-backup'

backupPlugin({
  storage: s3StorageAdapter({
    bucket: process.env.S3_BACKUP_BUCKET!,
    prefix: 'production',
    config: {
      region: process.env.S3_REGION!, // e.g. 'eu-west-1'
      // endpoint: 'https://s3.us-west-004.backblazeb2.com', // only for non-AWS services
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    },
  }),
})
```

The IAM user only needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on that bucket.

### 2. Turn on the schedule in the admin panel

Open **System → Backup Settings**:

- **Automatic backups**: on/off
- **Time of day** and **Timezone** (e.g. `03:00`, `Asia/Dhaka`)
- **Include uploaded files**
- **Daily**: keep the last *N* (default 7)
- **Weekly**: day of the week, keep the last *N* (default 4)
- **Monthly**: day of the month, keep the last *N* (default 12). In shorter months the last day is used.

The top of the page shows where backups go, plus the last and next backup for each schedule. Older backups beyond the keep counts are deleted automatically, from the list and from the bucket. When schedules coincide (a Sunday that is also the 1st), **one** backup is taken and counts for each of them.

You can set the initial values in code; editors can change them later in the admin panel:

```ts
backupPlugin({
  schedule: {
    defaults: {
      enabled: true,
      time: '02:30',
      timezone: 'Europe/London',
      daily: { enabled: true, keep: 7 },
      weekly: { enabled: true, day: 'sunday', keep: 4 },
      monthly: { enabled: true, day: 1, keep: 12 },
    },
  },
})
```

### 3. Make sure something triggers the schedule

**Long-running server** (VPS, Docker, Railway, Render, Fly…): nothing to do. The Payload server checks every 5 minutes (`schedule.intervalMinutes`) whether a backup is due. If the server was down at backup time, the backup is taken as soon as it is back.

**Serverless (Vercel, Netlify…)** or **several server instances**: turn the timer off and let one external cron call the plugin:

```ts
backupPlugin({
  schedule: {
    runOnServer: false,
    cronSecret: process.env.CRON_SECRET,
  },
})
```

Then call `GET /api/backups/cron` with `Authorization: Bearer <CRON_SECRET>` every 5–15 minutes. On Vercel, add this to `vercel.json`; Vercel sends the `CRON_SECRET` env var as the bearer token automatically:

```json
{ "crons": [{ "path": "/api/backups/cron", "schedule": "*/10 * * * *" }] }
```

Vercel's Hobby plan only allows one cron run per day. That is still enough: schedule it a few minutes after your backup time (e.g. `"10 3 * * *"` for 03:00 UTC), and each run takes whichever daily, weekly or monthly backup is due.

GitHub Actions, cron-job.org or a plain `crontab` work too:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://example.com/api/backups/cron
```

Each call takes at most one backup and only when one is due, so calling it often is harmless. Backups run inside that request; check your platform's function time limit (Vercel `maxDuration`) against your site's size.

If a scheduled backup fails, it is recorded as *Failed* with the error, and retried an hour later.

### Disaster recovery: restoring from the bucket on a new server

If the server and its database are lost, the archives are still in your bucket:

1. Deploy the same code to a new server with an empty database and the **same storage settings**. Run your migrations.
2. Create the first admin user, open **Backups** and click **Find backups in storage**, or run `pnpm payload backup:sync`.
3. Every archive in the bucket appears in the list (type *Found in storage*). Open the one you want and click **Restore…**.

### Switching storage

Each backup remembers which storage it was saved to. After switching (for example from the local folder to R2), older backups stay where they were, and exporting or restoring them shows a clear message. Copy those files over and use **Import backup…**, or switch the storage back to reach them.

### Your own storage

Any destination works. Implement `BackupStorageAdapter`:

```ts
const myStorage: BackupStorageAdapter = {
  name: 'my-storage',
  upload: async ({ filename, filePath, size }) => { /* ... */ },
  download: async ({ filename }) => /* a Readable stream */,
  delete: async ({ filename }) => { /* ... */ },
  list: async () => [/* { filename } */], // optional, enables "Find backups in storage"
}
```

## All options

```ts
backupPlugin({
  access: ({ req }) => req.user?.role === 'admin', // default: any signed-in admin-panel user
  storage: localStorageAdapter({ directory: './backups' }), // default; see r2StorageAdapter / s3StorageAdapter
  schedule: {
    defaults: { /* see above */ },
    runOnServer: true,       // timer inside the Payload server
    intervalMinutes: 5,
    cronSecret: undefined,   // enables GET /api/backups/cron for external crons
  },                         // or false to remove the scheduler
  collections: { exclude: ['form-submissions'] },  // or { include: [...] }
  globals: { exclude: [] },
  includeVersions: true,
  media: true,               // or { collections: ['media'], restoreFile }
  retention: { maxBackups: 14, maxAgeDays: 30 },   // manual/imported/before-restore backups only
  safetyBackupBeforeRestore: true,
  useTransaction: true,      // see "Large MongoDB databases"
  slug: 'backups',
  settingsSlug: 'backup-settings',
  adminGroup: 'System',
  batchSize: 500,
  tempDir: os.tmpdir(),
  disabled: false,           // keeps the collection and global, removes everything else
})
```

### Uploaded files on S3/R2 (cloud storage adapters)

Backups read files through the storage adapter's own handler, so files kept in S3, R2, Azure, GCS or Vercel Blob are included.

Restoring files into the bucket needs one callback. Without it, the database is restored and the files are skipped (a warning is logged):

```ts
backupPlugin({
  media: {
    restoreFile: async ({ collection, filename, filePath, prefix }) => {
      await s3.send(new PutObjectCommand({
        Bucket: 'my-media-bucket',
        Key: [prefix, filename].filter(Boolean).join('/'),
        Body: fs.createReadStream(filePath),
      }))
    },
  },
})
```

## REST API

All endpoints use the plugin's `access` function.

| Method | Path                                   | Body                           |
| ------ | -------------------------------------- | ------------------------------ |
| POST   | `/api/backups/run`                     | `{ "includeMedia": true }`     |
| GET    | `/api/backups/:id/download`            | (export)                       |
| POST   | `/api/backups/import?filename=x.tar.gz` | the `.tar.gz` file as raw body |
| POST   | `/api/backups/:id/restore`             | `{ "confirm": "RESTORE" }`     |
| POST   | `/api/backups/sync`                    | finds archives in storage      |
| GET    | `/api/backups/cron`                    | runs the schedule (`Bearer <cronSecret>` or admin) |
| GET    | `/api/backups`                         | list (standard Payload REST)   |
| DELETE | `/api/backups/:id`                     | deletes record and archive     |

`import` answers `400` for files that are not backups or come from another kind of database, and returns `warnings` for collections or globals that will be skipped.

```bash
# export
curl -H "Authorization: users API-Key $PAYLOAD_API_KEY" \
  -o site.tar.gz https://example.com/api/backups/12/download

# import
curl -X POST -H "Authorization: users API-Key $PAYLOAD_API_KEY" \
  -H "Content-Type: application/gzip" --data-binary @site.tar.gz \
  "https://example.com/api/backups/import?filename=site.tar.gz"
```

## Local API

```ts
import { createBackup, restoreBackup } from 'payload-plugin-backup'

const backup = await createBackup(payload, { includeMedia: true })
await restoreBackup(payload, backup.id)
```

While a restore writes to the database, `req.context.payloadPluginBackupRestore` is `true` (exported as `RESTORE_CONTEXT_KEY`).

## How a restore works

1. The archive is downloaded, its SHA-256 checksum verified and extracted.
2. A safety backup of the current state is taken (`type: pre-restore`).
3. In **one database transaction**: every backed-up collection is emptied and refilled with the original ids, versions are rebuilt oldest-first, and globals are overwritten.
   - Postgres/SQLite: foreign-key checks are postponed until the end of the transaction so documents can reference each other in any order. They are then verified all at once and the constraints are put back exactly as Payload created them. Serial id sequences are moved past the restored ids.
4. After the commit, uploaded files are written back.

If anything fails in step 3, the transaction is rolled back and the database is left untouched.

## Good to know

- **Restore into the same database engine.** MongoDB ObjectIDs and SQL ids aren't interchangeable, and imports from another engine are refused. Moving between servers on the same engine (local → production, Neon → RDS, Atlas → self-hosted) works.
- **Same schema.** Restore into a site running the same collections and fields as when the backup was taken. Run your migrations first. Collections or globals that no longer exist are skipped and reported.
- **Users are restored too.** Passwords revert to what they were at backup time, and you may be signed out.
- **Large MongoDB databases.** MongoDB aborts transactions after 60 seconds. For very large databases set `useTransaction: false`, which only affects MongoDB. SQL databases always use a transaction.
- **Serverless timeouts.** `run` and `restore` work inside the request. On platforms with short function timeouts, use `schedule` with a jobs runner, or call `createBackup` from a script.
- Backups contain password hashes and all private content. Restrict `access`, keep buckets private and treat downloaded archives as secrets.
- A backup you have never restored is not a verified backup. Test restoring into a staging site regularly.

## Developing this plugin

```bash
pnpm install
cp dev/.env.example dev/.env       # choose mongodb, postgres or sqlite
pnpm dev                           # http://localhost:3000/admin, dev@payloadcms.com / test

pnpm test:int                                   # MongoDB in memory, backups in ./backups
DATABASE_ADAPTER=postgres DATABASE_URL=postgres://127.0.0.1:5432/payload_backup_plugin_test pnpm test:int
DATABASE_ADAPTER=sqlite DATABASE_URL=file:/tmp/backup-test.db pnpm test:int

# against any S3-compatible server (MinIO, moto, a real bucket)
S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=test S3_ACCESS_KEY_ID=x S3_SECRET_ACCESS_KEY=y pnpm test:int

pnpm build                         # compiles src/ to dist/ for publishing
```

Plugin code lives in `src/`. `dev/` is a small Payload site (localized posts with drafts, blocks and arrays, categories, media with image sizes, a versioned global) used for manual testing and the integration tests in `dev/int.spec.ts`.

## License

MIT
