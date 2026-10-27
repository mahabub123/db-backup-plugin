import crypto from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream/promises'
import { describe, expect, test } from 'vitest'

import { s3StorageAdapter } from '../src/storage/s3.js'

/**
 * Runs against a real S3-compatible server when S3_ENDPOINT and S3_BUCKET are
 * set (MinIO, moto, LocalStack, or a real bucket), e.g.
 *   S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=test S3_ACCESS_KEY_ID=x S3_SECRET_ACCESS_KEY=y pnpm vitest run dev/s3.test.ts
 */
const enabled = Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET)

const storage = s3StorageAdapter({
  bucket: process.env.S3_BUCKET || 'unused',
  config: {
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    region: process.env.S3_REGION || 'us-east-1',
  },
  prefix: `adapter-test-${Date.now()}`,
})

const sha256 = async (filePath: string) => {
  const hash = crypto.createHash('sha256')
  await pipeline((await fs.open(filePath)).createReadStream(), hash)
  return hash.digest('hex')
}

const roundTrip = async (sizeBytes: number) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 's3-adapter-'))
  try {
    const source = path.join(dir, 'source.tar.gz')
    await fs.writeFile(source, crypto.randomBytes(sizeBytes))
    const filename = `backup-test-${sizeBytes}.tar.gz`

    await storage.upload({ filename, filePath: source, size: sizeBytes })
    expect((await storage.list!()).map((file) => file.filename)).toContain(filename)

    const copy = path.join(dir, 'copy.tar.gz')
    await pipeline(await storage.download({ filename }), (await fs.open(copy, 'w')).createWriteStream())
    expect(await sha256(copy)).toBe(await sha256(source))

    await storage.delete({ filename })
    expect((await storage.list!()).map((file) => file.filename)).not.toContain(filename)
  } finally {
    await fs.rm(dir, { force: true, recursive: true })
  }
}

describe.skipIf(!enabled)('s3StorageAdapter', () => {
  test('uploads, lists, downloads and deletes an archive', () => roundTrip(256 * 1024))

  test('uploads archives over 100 MB in parts', () => roundTrip(101 * 1024 * 1024), 300_000)
})
