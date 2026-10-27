import type { DatabaseAdapterObj } from 'payload'

import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { backupPlugin, r2StorageAdapter, s3StorageAdapter } from 'payload-plugin-backup'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

import { testEmailAdapter } from './helpers/testEmailAdapter.js'
import { seed } from './seed.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

if (!process.env.ROOT_DIR) {
  process.env.ROOT_DIR = dirname
}

/**
 * DATABASE_ADAPTER=mongodb (default) | postgres | sqlite
 * In tests, MongoDB runs in memory; Postgres and SQLite use DATABASE_URL.
 */
const getDatabaseAdapter = async (): Promise<DatabaseAdapterObj> => {
  const adapter = process.env.DATABASE_ADAPTER || 'mongodb'

  if (adapter === 'postgres') {
    const { postgresAdapter } = await import('@payloadcms/db-postgres')
    return postgresAdapter({
      pool: { connectionString: process.env.DATABASE_URL || '' },
      push: true,
    })
  }

  if (adapter === 'sqlite') {
    const { sqliteAdapter } = await import('@payloadcms/db-sqlite')
    return sqliteAdapter({
      client: { url: process.env.DATABASE_URL || 'file:./dev/payload.db' },
      push: true,
    })
  }

  const { mongooseAdapter } = await import('@payloadcms/db-mongodb')
  if (process.env.NODE_ENV === 'test') {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server')
    const memoryDB = await MongoMemoryReplSet.create({
      replSet: { count: 3, dbName: 'payloadmemory' },
    })
    process.env.DATABASE_URL = `${memoryDB.getUri()}&retryWrites=true`
  }
  return mongooseAdapter({ ensureIndexes: true, url: process.env.DATABASE_URL || '' })
}

/** R2 when R2_* is set, any S3-compatible bucket when S3_* is set, else ./backups. */
const getBackupStorage = () => {
  if (process.env.R2_BUCKET) {
    return r2StorageAdapter({
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      accountId: process.env.R2_ACCOUNT_ID || '',
      bucket: process.env.R2_BUCKET,
      prefix: process.env.BACKUP_PREFIX,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    })
  }
  if (process.env.S3_BUCKET) {
    return s3StorageAdapter({
      bucket: process.env.S3_BUCKET,
      config: {
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        },
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: Boolean(process.env.S3_ENDPOINT),
        region: process.env.S3_REGION || 'us-east-1',
      },
      prefix: process.env.BACKUP_PREFIX,
    })
  }
  return undefined
}

const buildDevConfig = async () =>
  buildConfig({
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
      user: 'users',
    },
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: 'media',
        fields: [{ name: 'alt', type: 'text' }],
        upload: {
          imageSizes: [{ name: 'thumbnail', height: 32, width: 32 }],
          staticDir: path.resolve(dirname, process.env.MEDIA_DIR || 'media'),
        },
      },
      {
        slug: 'categories',
        admin: { useAsTitle: 'title' },
        fields: [{ name: 'title', type: 'text', required: true }],
      },
      {
        slug: 'posts',
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'content', type: 'richText' },
          { name: 'author', type: 'relationship', relationTo: 'users' },
          { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
          { name: 'heroImage', type: 'upload', relationTo: 'media' },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              {
                slug: 'callToAction',
                fields: [
                  { name: 'label', type: 'text', localized: true },
                  { name: 'link', type: 'text' },
                ],
              },
            ],
          },
          {
            name: 'tags',
            type: 'array',
            fields: [{ name: 'tag', type: 'text' }],
          },
        ],
        versions: { drafts: true, maxPerDoc: 10 },
      },
    ],
    db: await getDatabaseAdapter(),
    editor: lexicalEditor(),
    email: testEmailAdapter,
    globals: [
      {
        slug: 'site-settings',
        fields: [
          { name: 'siteName', type: 'text', localized: true },
          { name: 'logo', type: 'upload', relationTo: 'media' },
        ],
        versions: true,
      },
    ],
    localization: {
      defaultLocale: 'en',
      locales: ['en', 'es'],
    },
    onInit: async (payload) => {
      await seed(payload)
    },
    plugins: [
      backupPlugin({
        retention: { maxBackups: 20 },
        schedule: {
          cronSecret: process.env.CRON_SECRET,
          // Tests drive the scheduler themselves with a fake clock.
          runOnServer: process.env.NODE_ENV !== 'test',
        },
        storage: getBackupStorage(),
        tempDir: process.env.BACKUP_TEMP_DIR,
      }),
    ],
    secret: process.env.PAYLOAD_SECRET || 'test-secret_key',
    sharp,
    typescript: {
      // Each Payload start would otherwise spawn `payload generate:types`, which
      // re-loads this config (and, in tests, boots another in-memory MongoDB).
      // Run `pnpm generate:types` after changing collections instead.
      autoGenerate: false,
      outputFile: path.resolve(dirname, 'payload-types.ts'),
    },
  })

export default buildDevConfig()
