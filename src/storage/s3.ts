import type * as S3 from '@aws-sdk/client-s3'
import type { Readable } from 'stream'

import fs from 'fs'

import type { BackupStorageAdapter } from '../types.js'

import { assertSafeFilename } from '../utilities/filename.js'

export type S3StorageAdapterArgs = {
  bucket: string
  /**
   * Passed to `new S3Client()`. For Cloudflare R2 prefer `r2StorageAdapter`,
   * which fills this in for you.
   */
  config: S3.S3ClientConfig
  /** Key prefix, e.g. 'backups/production'. @default 'payload-backups' */
  prefix?: string
}

type Loaded = { client: S3.S3Client; sdk: typeof S3 }

/**
 * Stores archives in any S3-compatible bucket (AWS S3, Cloudflare R2,
 * Backblaze B2, MinIO, DigitalOcean Spaces, ...).
 * Requires `@aws-sdk/client-s3` in your project. Archives larger than
 * 100 MB are sent in parts when `@aws-sdk/lib-storage` is installed too.
 * Use a private bucket: archives contain your whole database.
 */
export const s3StorageAdapter = ({
  bucket,
  config,
  prefix = 'payload-backups',
}: S3StorageAdapterArgs): BackupStorageAdapter => {
  let loaded: null | Promise<Loaded> = null
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '')

  const getClient = () => {
    if (!loaded) {
      loaded = import('@aws-sdk/client-s3')
        .then((sdk) => ({ client: new sdk.S3Client(config), sdk }))
        .catch((error: unknown) => {
          loaded = null
          throw new Error(
            'payload-plugin-backup: the S3/R2 storage adapter needs "@aws-sdk/client-s3". Install it with `pnpm add @aws-sdk/client-s3`.',
            { cause: error },
          )
        })
    }
    return loaded
  }

  const key = (filename: string) =>
    [cleanPrefix, assertSafeFilename(filename)].filter(Boolean).join('/')

  return {
    name: 's3',
    delete: async ({ filename }) => {
      const { client, sdk } = await getClient()
      await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key(filename) }))
    },
    download: async ({ filename }) => {
      const { client, sdk } = await getClient()
      const result = await client.send(
        new sdk.GetObjectCommand({ Bucket: bucket, Key: key(filename) }),
      )
      if (!result.Body) {
        throw new Error(`Backup "${filename}" is empty in bucket "${bucket}"`)
      }
      return result.Body as Readable
    },
    list: async () => {
      const { client, sdk } = await getClient()
      const files: { filename: string; size?: number }[] = []
      let ContinuationToken: string | undefined
      do {
        const page = await client.send(
          new sdk.ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken,
            Prefix: cleanPrefix ? `${cleanPrefix}/` : undefined,
          }),
        )
        for (const object of page.Contents ?? []) {
          const filename = object.Key?.slice(cleanPrefix ? cleanPrefix.length + 1 : 0)
          // Only archives directly under the prefix, not in sub-folders.
          if (filename && !filename.includes('/') && filename.endsWith('.tar.gz')) {
            files.push({ filename, size: object.Size })
          }
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (ContinuationToken)
      return files
    },
    upload: async ({ filename, filePath, size }) => {
      const { client, sdk } = await getClient()
      const params = {
        Body: fs.createReadStream(filePath),
        Bucket: bucket,
        ContentType: 'application/gzip',
        Key: key(filename),
      }

      if (size > 100 * 1024 * 1024) {
        const libStorage = await import('@aws-sdk/lib-storage').catch(() => null)
        if (libStorage) {
          await new libStorage.Upload({ client, params, partSize: 64 * 1024 * 1024 }).done()
          return
        }
      }

      // A single PUT accepts up to 5 GB.
      await client.send(new sdk.PutObjectCommand({ ...params, ContentLength: size }))
    },
  }
}

export type R2StorageAdapterArgs = {
  accessKeyId: string
  /** Your Cloudflare account id (in the R2 dashboard URL). */
  accountId: string
  bucket: string
  /** Set for buckets created with a jurisdiction, e.g. 'eu'. */
  jurisdiction?: 'eu' | 'fedramp'
  /** @default 'payload-backups' */
  prefix?: string
  secretAccessKey: string
}

/**
 * Stores archives in a Cloudflare R2 bucket. Create an R2 API token with
 * "Object Read & Write" on the bucket and pass its keys here.
 */
export const r2StorageAdapter = ({
  accessKeyId,
  accountId,
  bucket,
  jurisdiction,
  prefix,
  secretAccessKey,
}: R2StorageAdapterArgs): BackupStorageAdapter => ({
  ...s3StorageAdapter({
    bucket,
    config: {
      credentials: { accessKeyId, secretAccessKey },
      endpoint: `https://${accountId}${jurisdiction ? `.${jurisdiction}` : ''}.r2.cloudflarestorage.com`,
      region: 'auto',
      // Newer AWS SDKs add checksums R2 doesn't need; only send them when required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    },
    prefix,
  }),
  name: 'r2',
})
