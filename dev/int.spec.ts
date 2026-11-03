import type { Endpoint, Payload, PayloadRequest, TypedUser } from 'payload'

import config from '@payload-config'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createPayloadRequest, getPayload } from 'payload'
import {
  createBackup,
  getBackupHealth,
  RESTORE_CONTEXT_KEY,
  restoreBackup,
  runScheduledBackups,
  verifyBackup,
} from 'payload-plugin-backup'
import sharp from 'sharp'
import * as tar from 'tar'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { checkMigrations } from '../src/core/compatibility.js'
import { supportsTransactions } from '../src/core/database.js'
import { isEncryptedFile } from '../src/core/integrity.js'
import { LEASE_ID, STALE_AFTER } from '../src/core/lock.js'
import { extractArchive } from '../src/core/restoreBackup.js'
import { getOptions } from '../src/utilities/getOptions.js'
import { devUser } from './helpers/credentials.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const mediaDir = path.resolve(dirname, process.env.MEDIA_DIR || 'media')

let payload: Payload
let user: TypedUser
/** Backups read from one snapshot on Postgres and MongoDB (not SQLite, see beginReadSnapshot). */
let hasSnapshots = true

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

/** Works for any storage adapter (local folder, S3, R2). */
const inStorage = async (filename: string) =>
  ((await getOptions(payload).storage.list?.()) ?? []).some((file) => file.filename === filename)

const getEndpoint = (pathname: string, method: string): Endpoint => {
  const endpoint = payload.collections.backups.config.endpoints
    ? payload.collections.backups.config.endpoints.find(
        (e) => e.path === pathname && e.method === method,
      )
    : undefined
  if (!endpoint) {
    throw new Error(`Endpoint ${method} ${pathname} not found`)
  }
  return endpoint
}

const buildRequest = async ({
  body,
  headers,
  method = 'GET',
  routeParams,
  url,
  withUser = true,
}: {
  body?: BodyInit
  headers?: Record<string, string>
  method?: string
  routeParams?: Record<string, unknown>
  url: string
  withUser?: boolean
}): Promise<PayloadRequest> => {
  const req = await createPayloadRequest({
    config,
    request: new Request(`http://localhost:3000/api/backups${url}`, {
      body,
      // @ts-expect-error -- required by Node when streaming a body
      duplex: 'half',
      headers,
      method,
    }),
  })
  req.user = withUser ? user : null
  req.routeParams = routeParams
  return req
}

/** Unpacks an archive, lets `edit` change its manifest, and packs it again. */
const editArchive = async (
  archive: Buffer,
  edit: (manifest: Record<string, any>) => void,
): Promise<Buffer> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'))
  try {
    await fs.writeFile(path.join(dir, 'in.tar.gz'), archive)
    await fs.mkdir(path.join(dir, 'data'))
    await tar.extract({ cwd: path.join(dir, 'data'), file: path.join(dir, 'in.tar.gz') })
    const manifestPath = path.join(dir, 'data', 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    edit(manifest)
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    await tar.create({ cwd: path.join(dir, 'data'), file: path.join(dir, 'out.tar.gz'), gzip: true }, ['.'])
    return await fs.readFile(path.join(dir, 'out.tar.gz'))
  } finally {
    await fs.rm(dir, { force: true, recursive: true })
  }
}

/** Text content of one file inside an archive. */
const readArchiveFile = async (archive: Buffer, file: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'))
  try {
    await fs.writeFile(path.join(dir, 'in.tar.gz'), archive)
    await tar.extract({ cwd: dir, file: path.join(dir, 'in.tar.gz') })
    return await fs.readFile(path.join(dir, file), 'utf8')
  } finally {
    await fs.rm(dir, { force: true, recursive: true })
  }
}

const downloadArchive = async (id: number | string): Promise<Buffer> => {
  const req = await buildRequest({ routeParams: { id }, url: `/${id}/download` })
  const response = await getEndpoint('/:id/download', 'get').handler(req)
  return Buffer.from(await response.arrayBuffer())
}

const importArchive = async (archive: Buffer) => {
  const req = await buildRequest({
    body: archive,
    headers: { 'Content-Type': 'application/gzip' },
    method: 'POST',
    url: '/import?filename=site.tar.gz',
  })
  return getEndpoint('/import', 'post').handler(req)
}

beforeAll(async () => {
  payload = await getPayload({ config })
  hasSnapshots = supportsTransactions(payload) && !payload.db.packageName?.includes('sqlite')
  const { docs } = await payload.find({
    collection: 'users',
    where: { email: { equals: devUser.email } },
  })
  user = { ...docs[0], collection: 'users' } as TypedUser
})

afterAll(async () => {
  await payload?.destroy()
})

describe('payload-plugin-backup', () => {
  test('adds the backups collection', () => {
    expect(payload.collections.backups).toBeDefined()
  })

  test('backs up and restores the whole site', async () => {
    const image = await sharp({
      create: { background: '#ff0000', channels: 3, height: 64, width: 64 },
    })
      .png()
      .toBuffer()

    const media = await payload.create({
      collection: 'media',
      data: { alt: 'Red square' },
      file: { data: image, mimetype: 'image/png', name: 'red.png', size: image.length },
    })
    const category = await payload.create({ collection: 'categories', data: { title: 'News' } })

    const post = await payload.create({
      collection: 'posts',
      data: {
        _status: 'published',
        author: user.id,
        categories: [category.id],
        heroImage: media.id,
        layout: [{ blockType: 'callToAction', label: 'Read more', link: '/news' }],
        tags: [{ tag: 'first' }, { tag: 'second' }],
        title: 'Hello world',
      },
      locale: 'en',
    })
    await payload.update({
      id: post.id,
      collection: 'posts',
      data: { _status: 'published', title: 'Hola mundo' },
      locale: 'es',
    })
    // An unpublished draft on top of the published version.
    await payload.update({
      id: post.id,
      collection: 'posts',
      data: { title: 'Hello world (draft)' },
      draft: true,
      locale: 'en',
    })
    await payload.updateGlobal({
      slug: 'site-settings',
      data: { logo: media.id, siteName: 'My Site' },
      locale: 'en',
    })

    const versionsBefore = await payload.countVersions({
      collection: 'posts',
      where: { parent: { equals: post.id } },
    })

    const backup = await createBackup(payload, { user })

    expect(backup.status).toBe('completed')
    expect(backup.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(backup.files).toBe(2) // original + thumbnail
    expect(await inStorage(backup.filename)).toBe(true)

    // Damage the site in every way we can think of.
    await payload.delete({ id: post.id, collection: 'posts' })
    await payload.delete({ id: category.id, collection: 'categories' })
    await payload.create({ collection: 'posts', data: { title: 'Created after the backup' } })
    await payload.updateGlobal({ slug: 'site-settings', data: { siteName: 'Changed' } })
    await fs.rm(path.join(mediaDir, media.filename!))
    await payload.update({
      id: user.id,
      collection: 'users',
      data: { password: 'a-new-password' },
    })

    const { safetyBackup, summary } = await restoreBackup(payload, backup.id, { user })

    expect(safetyBackup?.type).toBe('pre-restore')
    expect(summary.skipped).toEqual([])
    expect(summary.files.restored).toBe(2)

    // Published version, both locales, every kind of relationship.
    const restored = await payload.findByID({
      id: post.id,
      collection: 'posts',
      depth: 1,
      locale: 'all',
    })
    expect(restored.title).toEqual({ en: 'Hello world', es: 'Hola mundo' })
    expect(restored.categories?.map((c) => (typeof c === 'object' ? c.id : c))).toEqual([
      category.id,
    ])
    expect(typeof restored.heroImage === 'object' && restored.heroImage?.id).toBe(media.id)
    expect(typeof restored.author === 'object' && restored.author?.id).toBe(user.id)
    expect(restored.layout?.[0]).toMatchObject({ label: { en: 'Read more' }, link: '/news' })
    expect(restored.tags?.map(({ tag }) => tag)).toEqual(['first', 'second'])

    // The pending draft and the version history are back too.
    const draft = await payload.findByID({ id: post.id, collection: 'posts', draft: true })
    expect(draft.title).toBe('Hello world (draft)')
    const versionsAfter = await payload.countVersions({
      collection: 'posts',
      where: { parent: { equals: post.id } },
    })
    expect(versionsAfter.totalDocs).toBe(versionsBefore.totalDocs)

    // Documents created after the backup are gone.
    const { totalDocs } = await payload.count({
      collection: 'posts',
      where: { title: { equals: 'Created after the backup' } },
    })
    expect(totalDocs).toBe(0)

    const settings = await payload.findGlobal({ slug: 'site-settings', depth: 0 })
    expect(settings.siteName).toBe('My Site')
    expect(settings.logo).toBe(media.id)

    // Files on disk, including generated image sizes.
    expect(await exists(path.join(mediaDir, media.filename!))).toBe(true)
    expect(await exists(path.join(mediaDir, media.sizes!.thumbnail!.filename!))).toBe(true)

    // Password hashes were restored: the old password works again.
    const login = await payload.login({
      collection: 'users',
      data: { email: devUser.email, password: devUser.password },
    })
    expect(login.token).toBeTruthy()

    // New documents get fresh ids that don't collide with restored ones.
    const newCategory = await payload.create({ collection: 'categories', data: { title: 'New' } })
    expect(newCategory.id).not.toBe(category.id)
  })

  test('rejects anonymous requests', async () => {
    const req = await buildRequest({ method: 'POST', url: '/run', withUser: false })
    const response = await getEndpoint('/run', 'post').handler(req)
    expect(response.status).toBe(403)
  })

  test('refuses to restore without confirmation', async () => {
    const backup = await createBackup(payload, { includeMedia: false, user })
    const req = await buildRequest({
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      routeParams: { id: backup.id },
      url: `/${backup.id}/restore`,
    })
    const response = await getEndpoint('/:id/restore', 'post').handler(req)
    expect(response.status).toBe(400)
  })

  test('downloads a backup and imports it again', async () => {
    const runReq = await buildRequest({
      body: JSON.stringify({ includeMedia: true }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      url: '/run',
    })
    const runResponse = await getEndpoint('/run', 'post').handler(runReq)
    expect(runResponse.status).toBe(201)
    const { doc: backup } = await runResponse.json()

    const downloadReq = await buildRequest({
      routeParams: { id: backup.id },
      url: `/${backup.id}/download`,
    })
    const download = await getEndpoint('/:id/download', 'get').handler(downloadReq)
    expect(download.status).toBe(200)
    expect(download.headers.get('Content-Type')).toBe('application/gzip')
    const archive = Buffer.from(await download.arrayBuffer())
    expect(archive.length).toBe(backup.size)

    const importReq = await buildRequest({
      body: archive,
      headers: { 'Content-Type': 'application/gzip' },
      method: 'POST',
      url: '/import',
    })
    const imported = await getEndpoint('/import', 'post').handler(importReq)
    expect(imported.status).toBe(201)
    const { doc } = await imported.json()
    expect(doc.type).toBe('imported')
    expect(doc.signed).toBe(true)
    expect(backup.signed).toBe(true)
    expect(backup.snapshot).toBe(hasSnapshots)
    expect(doc.checksum).toBe(backup.checksum)
    expect(doc.documents).toBe(backup.documents)

    const garbageReq = await buildRequest({
      body: Buffer.from('not a backup'),
      method: 'POST',
      url: '/import',
    })
    const garbage = await getEndpoint('/import', 'post').handler(garbageReq)
    expect(garbage.status).toBe(400)
  })

  test('registers the backup:export and backup:import commands', async () => {
    const keys = (payload.config.bin ?? []).map(({ key }) => key)
    expect(keys).toEqual(expect.arrayContaining(['backup:export', 'backup:import']))
    for (const { scriptPath } of payload.config.bin ?? []) {
      expect(await exists(scriptPath)).toBe(true)
    }
  })

  test('rejects a backup taken from a different kind of database', async () => {
    const backup = await createBackup(payload, { includeMedia: false, user })
    const foreign = payload.db.name === 'mongoose' ? '@payloadcms/db-postgres' : '@payloadcms/db-mongodb'
    const archive = await editArchive(await downloadArchive(backup.id), (manifest) => {
      manifest.databaseAdapter = foreign
    })
    const response = await importArchive(archive)
    expect(response.status).toBe(400)
    const { errors } = await response.json()
    expect(errors[0].message).toMatch(/can only be restored on a/)
  })

  test('imports a backup with unknown collections and restores the rest', async () => {
    const category = await payload.create({ collection: 'categories', data: { title: 'Kept' } })
    const backup = await createBackup(payload, { includeMedia: false, user })
    const archive = await editArchive(await downloadArchive(backup.id), (manifest) => {
      manifest.collections.push({ slug: 'old-collection', count: 0, versions: 0 })
    })

    const response = await importArchive(archive)
    expect(response.status).toBe(201)
    const { doc, warnings } = await response.json()
    expect(doc.importedFrom).toBe('site.tar.gz')
    expect(warnings.join(' ')).toContain('old-collection')

    // Editing the manifest broke its signature: a restore needs explicit trust.
    expect(doc.signed).toBe(false)
    await expect(restoreBackup(payload, doc.id, { user })).rejects.toThrow(/not signed by this site/)

    await payload.delete({ id: category.id, collection: 'categories' })
    const { summary } = await restoreBackup(payload, doc.id, { allowUnverified: true, user })
    expect(summary.skipped).toEqual(['old-collection'])
    const restored = await payload.findByID({ id: category.id, collection: 'categories' })
    expect(restored.title).toBe('Kept')
  })

  test('deleting a backup deletes its archive', async () => {
    const backup = await createBackup(payload, { includeMedia: false, user })
    expect(await inStorage(backup.filename)).toBe(true)
    await payload.delete({ id: backup.id, collection: 'backups' })
    expect(await inStorage(backup.filename)).toBe(false)
  })

  test('finds backups in storage that are missing from the list', async () => {
    const backup = await createBackup(payload, { includeMedia: false, user })
    // Drop the record only (as if the database was lost); the archive stays in storage.
    await payload.db.deleteOne({ collection: 'backups', where: { id: { equals: backup.id } } })

    const req = await buildRequest({ method: 'POST', url: '/sync' })
    const response = await getEndpoint('/sync', 'post').handler(req)
    expect(response.status).toBe(200)

    const { docs } = await payload.find({
      collection: 'backups',
      where: { filename: { equals: backup.filename } },
    })
    expect(docs).toHaveLength(1)
    expect(docs[0].type).toBe('found')
    expect(docs[0].checksum).toBe(backup.checksum)
  })

  test('keeps every version when many share the same timestamp', async () => {
    const options = getOptions(payload)
    const { batchSize } = options
    const stamp = '2026-01-01T00:00:00.000Z'
    await payload.db.deleteVersions({ globalSlug: 'site-settings', where: {} })
    for (let i = 0; i < 9; i++) {
      await payload.db.createGlobalVersion({
        autosave: false,
        createdAt: stamp,
        globalSlug: 'site-settings',
        updatedAt: stamp,
        versionData: { siteName: { en: `Version ${i}` } } as any,
      })
    }

    // Read a few versions at a time, so the export needs several pages.
    options.batchSize = 2
    try {
      const backup = await createBackup(payload, { includeMedia: false, user })
      const lines = (await readArchiveFile(await downloadArchive(backup.id), 'global-versions/site-settings.ndjson'))
        .trim()
        .split('\n')
      const names = lines.map((line) => JSON.parse(line).version.siteName.en)
      expect(names).toHaveLength(9)
      expect(new Set(names).size).toBe(9)
    } finally {
      options.batchSize = batchSize
    }
  })

  test('runs one backup or restore at a time', async () => {
    const backup = await createBackup(payload, { includeMedia: false, user })

    const restoring = restoreBackup(payload, backup.id, { user })
    await expect(createBackup(payload, { includeMedia: false, user })).rejects.toThrow(
      /restore is already in progress/,
    )
    await expect(restoreBackup(payload, backup.id, { user })).rejects.toThrow(
      /restore is already in progress/,
    )
    await restoring

    // Free again once the restore has finished.
    expect((await createBackup(payload, { includeMedia: false, user })).status).toBe('completed')
  })

  test('restores again without a transaction when MongoDB ends it', async () => {
    if (!payload.db.packageName?.includes('mongo')) {
      return
    }
    const category = await payload.create({ collection: 'categories', data: { title: 'Before' } })
    const backup = await createBackup(payload, { includeMedia: false, user })
    await payload.update({ id: category.id, collection: 'categories', data: { title: 'After' } })

    // What MongoDB answers once a transaction has run longer than 60 seconds.
    const create = payload.db.create
    let attempts = 0
    let timeoutPending = false
    payload.db.create = (async (args) => {
      if (timeoutPending && args.req?.context?.[RESTORE_CONTEXT_KEY] && args.req.transactionID) {
        timeoutPending = false
        attempts++
        throw Object.assign(new Error('Transaction with { txnNumber: 1 } has been aborted.'), {
          code: 251,
          codeName: 'NoSuchTransaction',
        })
      }
      return create.call(payload.db, args)
    }) as typeof create

    const options = getOptions(payload)
    try {
      options.useTransaction = true
      timeoutPending = true
      await expect(restoreBackup(payload, backup.id, { user })).rejects.toThrow(/useTransaction: false/)
      expect((await payload.findByID({ id: category.id, collection: 'categories' })).title).toBe('After')

      options.useTransaction = undefined
      timeoutPending = true
      await restoreBackup(payload, backup.id, { user })
    } finally {
      payload.db.create = create
      options.useTransaction = undefined
    }
    expect(attempts).toBe(2)
    expect((await payload.findByID({ id: category.id, collection: 'categories' })).title).toBe('Before')

    // `useTransaction: false` commits every few documents; everything still comes back.
    await payload.update({ id: category.id, collection: 'categories', data: { title: 'After' } })
    const { batchSize } = options
    try {
      options.useTransaction = false
      options.batchSize = 2
      await restoreBackup(payload, backup.id, { user })
    } finally {
      options.useTransaction = undefined
      options.batchSize = batchSize
    }
    expect((await payload.findByID({ id: category.id, collection: 'categories' })).title).toBe('Before')
    expect(await payload.count({ collection: 'users' })).toEqual({ totalDocs: 1 })
  })

  test('refuses to run while another server holds the lock, and takes over a stale one', async () => {
    const options = getOptions(payload)
    const backup = await createBackup(payload, { includeMedia: false, user })
    const lease = (heartbeatAt: number) => ({
      id: LEASE_ID,
      heartbeatAt,
      owner: 'other-server:1:abcd',
      startedAt: heartbeatAt,
      task: 'backup',
    })

    // Another server is taking a backup right now (its heartbeat is fresh).
    await payload.db.create({ collection: options.lockSlug, customID: LEASE_ID, data: lease(Date.now()) })
    // ...and its backup record says so.
    const running = await payload.create({
      collection: 'backups',
      data: { type: 'manual', filename: 'elsewhere.tar.gz', startedAt: new Date().toISOString(), status: 'running' },
      overrideAccess: true,
    })
    try {
      await expect(restoreBackup(payload, backup.id, { user })).rejects.toThrow(
        /backup is already in progress on another server/,
      )
      await expect(createBackup(payload, { includeMedia: false, user })).rejects.toThrow(
        /on another server/,
      )
      expect((await payload.findByID({ id: running.id, collection: 'backups' })).status).toBe('running')

      // That server died: no heartbeat for longer than STALE_AFTER.
      await payload.db.updateOne({
        collection: options.lockSlug,
        data: { heartbeatAt: Date.now() - STALE_AFTER - 1000 },
        where: { id: { equals: LEASE_ID } },
      })
      const failures: unknown[] = []
      options.afterBackupFailed = ({ backup: failed }) => {
        failures.push(failed?.filename)
      }
      const next = await createBackup(payload, { includeMedia: false, user })
      expect(next.status).toBe('completed')

      // Its backup is marked interrupted, and reported.
      const interrupted = await payload.findByID({ id: running.id, collection: 'backups' })
      expect(interrupted.status).toBe('failed')
      expect(interrupted.error).toMatch(/Interrupted/)
      expect(failures).toEqual(['elsewhere.tar.gz'])
      // The lock was released afterwards.
      expect(await payload.db.findOne({ collection: options.lockSlug, where: {} })).toBeNull()
    } finally {
      options.afterBackupFailed = undefined
      await payload.db.deleteOne({ collection: options.lockSlug, where: { id: { equals: LEASE_ID } } }).catch(() => undefined)
      await payload.db.deleteOne({ collection: 'backups', where: { id: { equals: running.id } } })
    }
  })

  test('keeps renewing its lock while a restore holds the database', async () => {
    const options = getOptions(payload)
    const backup = await createBackup(payload, { includeMedia: false, user })
    const create = payload.db.create
    let renewed: string | undefined
    // In the middle of the restore transaction (after foreign keys were deferred on
    // Postgres), renew the lease the way the heartbeat does, on another connection.
    // SQLite has a single writer and skips renewals during a restore (see withLock).
    const sqlite = Boolean(payload.db.packageName?.includes('sqlite'))
    payload.db.create = (async (args) => {
      if (!sqlite && !renewed && args.req?.context?.[RESTORE_CONTEXT_KEY]) {
        renewed = await Promise.race([
          payload.db
            .updateOne({
              collection: options.lockSlug,
              data: { heartbeatAt: Date.now() },
              where: { id: { equals: LEASE_ID } },
              ...(payload.db.name === 'mongoose' ? {} : { options: { atomic: true } }),
            })
            .then((lease) => (lease ? 'renewed' : 'missing'))
            .catch(() => 'busy'),
          new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 5000)),
        ])
      }
      return create.call(payload.db, args)
    }) as typeof create
    try {
      await restoreBackup(payload, backup.id, { user })
    } finally {
      payload.db.create = create
    }
    expect(renewed).toBe(sqlite ? undefined : 'renewed')
    // The lock is released afterwards.
    expect(await payload.db.findOne({ collection: options.lockSlug, where: {} })).toBeNull()
  })

  test('reads every collection from one snapshot, even while editors keep working', async () => {
    const find = payload.db.find
    let written = false
    // Right after the backup's first read, an editor creates a category on another
    // connection. The backup reads categories later, but must not see it.
    payload.db.find = (async (args) => {
      const result = await find.call(payload.db, args)
      if (!written && args.req?.transactionID && args.collection === 'users') {
        written = true
        await payload.db.create({ collection: 'categories', data: { title: 'Written during the backup' } })
      }
      return result
    }) as typeof find
    let backup
    try {
      backup = await createBackup(payload, { includeMedia: false, user })
    } finally {
      payload.db.find = find
    }
    if (!hasSnapshots) {
      // No snapshot to read from: the backup says so instead.
      expect(backup.snapshot).toBe(false)
      await payload.delete({ collection: 'categories', where: { title: { equals: 'Written during the backup' } } })
      return
    }
    expect(written).toBe(true)
    expect(backup.snapshot).toBe(true)
    const categories = await readArchiveFile(await downloadArchive(backup.id), 'collections/categories.ndjson')
    expect(categories).not.toContain('Written during the backup')
    await payload.delete({ collection: 'categories', where: { title: { equals: 'Written during the backup' } } })
  })

  test('pauses writes while a restore runs on any server', async () => {
    const options = getOptions(payload)
    await payload.db.create({
      collection: options.lockSlug,
      customID: LEASE_ID,
      data: { id: LEASE_ID, heartbeatAt: Date.now(), owner: 'other-server:2:abcd', startedAt: Date.now(), task: 'restore' },
    })
    // Each server looks at the lease at most every 2 seconds.
    await new Promise((resolve) => setTimeout(resolve, 2100))
    try {
      await expect(
        payload.create({ collection: 'categories', data: { title: 'During restore' } }),
      ).rejects.toThrow(/being restored/)
      await expect(
        payload.updateGlobal({ slug: 'site-settings', data: { siteName: 'During restore' } }),
      ).rejects.toThrow(/being restored/)
      // Code that knows what it is doing can still write.
      const allowed = await payload.create({
        collection: 'categories',
        context: { [RESTORE_CONTEXT_KEY]: true },
        data: { title: 'Allowed during restore' },
      })
      await payload.delete({ id: allowed.id, collection: 'categories', context: { [RESTORE_CONTEXT_KEY]: true } })
    } finally {
      await payload.db.deleteOne({ collection: options.lockSlug, where: { id: { equals: LEASE_ID } } })
    }
    // The guard caches its answer for 2 seconds.
    await new Promise((resolve) => setTimeout(resolve, 2100))
    const category = await payload.create({ collection: 'categories', data: { title: 'After restore' } })
    await payload.delete({ id: category.id, collection: 'categories' })
  })

  test('refuses archives that were changed after the backup', async () => {
    const category = await payload.create({ collection: 'categories', data: { title: 'Original' } })
    const backup = await createBackup(payload, { includeMedia: false, user })

    // Someone with access to the bucket edits a document, keeping the manifest.
    const archive = await downloadArchive(backup.id)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'))
    try {
      await fs.writeFile(path.join(dir, 'in.tar.gz'), archive)
      await fs.mkdir(path.join(dir, 'data'))
      await tar.extract({ cwd: path.join(dir, 'data'), file: path.join(dir, 'in.tar.gz') })
      const file = path.join(dir, 'data', 'collections', 'categories.ndjson')
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Original', 'Forged'))
      await tar.create({ cwd: path.join(dir, 'data'), file: path.join(dir, 'out.tar.gz'), gzip: true }, ['.'])
      const response = await importArchive(await fs.readFile(path.join(dir, 'out.tar.gz')))
      const { doc } = await response.json()

      // Even with explicit trust: the checksums inside the manifest don't match.
      await expect(restoreBackup(payload, doc.id, { allowUnverified: true, user })).rejects.toThrow(
        /categories\.ndjson was changed/,
      )
      const verification = await verifyBackup(payload, doc.id)
      expect(verification.ok).toBe(false)
    } finally {
      await fs.rm(dir, { force: true, recursive: true })
      await payload.delete({ id: category.id, collection: 'categories' })
    }
  })

  test('verifies a stored backup without touching the site', async () => {
    const backup = await createBackup(payload, { includeMedia: true, user })
    const result = await verifyBackup(payload, backup.id)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.signed).toBe(true)
    expect(result.documents).toBe(backup.documents)
    const stored = await payload.findByID({ id: backup.id, collection: 'backups' })
    expect(stored.verified).toBe(true)
    expect(stored.verifiedAt).toBeTruthy()
  })

  test('encrypts archives when a key is set', async () => {
    const options = getOptions(payload)
    const category = await payload.create({ collection: 'categories', data: { title: 'Secret' } })
    options.encryption = { key: 'a-long-random-test-key', previousKeys: [] }
    let backup
    try {
      backup = await createBackup(payload, { includeMedia: true, user })
      expect(backup.filename).toMatch(/\.tar\.gz\.enc$/)
      expect(backup.encrypted).toBe(true)

      const archive = await downloadArchive(backup.id)
      expect(archive.includes(Buffer.from('Secret'))).toBe(false)
      const file = path.join(os.tmpdir(), `enc-${Date.now()}`)
      await fs.writeFile(file, archive)
      expect(await isEncryptedFile(file)).toBe(true)
      await fs.rm(file)

      expect((await verifyBackup(payload, backup.id)).ok).toBe(true)
      await payload.update({ id: category.id, collection: 'categories', data: { title: 'Changed' } })

      // After a key change, the old key still decrypts.
      options.encryption = { key: 'the-new-key', previousKeys: ['a-long-random-test-key'] }
      await restoreBackup(payload, backup.id, { user })
      expect((await payload.findByID({ id: category.id, collection: 'categories' })).title).toBe('Secret')

      // Without the key there is no way in.
      options.encryption = { key: 'a-wrong-key', previousKeys: [] }
      await expect(restoreBackup(payload, backup.id, { user })).rejects.toThrow(/none of the configured encryption keys/)
      options.encryption = undefined
      await expect(restoreBackup(payload, backup.id, { user })).rejects.toThrow(/This backup is encrypted/)
    } finally {
      options.encryption = undefined
      await payload.delete({ id: category.id, collection: 'categories' })
    }
  })

  test('reports completed and failed backups to the callbacks', async () => {
    const options = getOptions(payload)
    const events: string[] = []
    options.afterBackup = ({ backup }) => {
      events.push(`done ${backup.status}`)
    }
    options.afterBackupFailed = ({ error }) => {
      events.push(`failed ${(error as Error).message}`)
    }
    const upload = options.storage.upload
    try {
      await createBackup(payload, { includeMedia: false, user })
      options.storage.upload = () => Promise.reject(new Error('bucket unavailable'))
      await expect(createBackup(payload, { includeMedia: false, user })).rejects.toThrow(/bucket unavailable/)
    } finally {
      options.storage.upload = upload
      options.afterBackup = undefined
      options.afterBackupFailed = undefined
    }
    expect(events).toEqual(['done completed', 'failed bucket unavailable'])
  })

  test('never unpacks links from an archive', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-'))
    try {
      await fs.mkdir(path.join(dir, 'src'))
      await fs.writeFile(path.join(dir, 'src', 'ok.txt'), 'fine')
      await fs.symlink('/etc/hosts', path.join(dir, 'src', 'evil'))
      await tar.create({ cwd: path.join(dir, 'src'), file: path.join(dir, 'a.tar.gz'), gzip: true }, ['.'])
      await extractArchive({ archivePath: path.join(dir, 'a.tar.gz'), dir: path.join(dir, 'out') })
      expect(await exists(path.join(dir, 'out', 'ok.txt'))).toBe(true)
      expect(await exists(path.join(dir, 'out', 'evil'))).toBe(false)
    } finally {
      await fs.rm(dir, { force: true, recursive: true })
    }
  })

  test('warns when the schema changed since the backup', async () => {
    const warnings = await checkMigrations({
      manifest: { migrations: ['20200101_000000_old_schema'] } as any,
      payload,
    })
    // The in-memory test database has no migrations; the archive's one is unknown here.
    expect(warnings.join(' ')).toMatch(/migration\(s\) this site doesn't have/)
  })
})

describe('automatic backups', () => {
  const scheduled = async () =>
    (
      await payload.find({
        collection: 'backups',
        limit: 0,
        pagination: false,
        sort: '-startedAt',
        where: { type: { equals: 'scheduled' } },
      })
    ).docs

  const run = (iso: string) =>
    runScheduledBackups({ now: new Date(iso), options: getOptions(payload), payload })

  // Start from a clean slate, so the tests also pass on a database used before.
  beforeAll(async () => {
    const { defaults } = getOptions(payload).schedule
    await payload.updateGlobal({ slug: 'backup-settings', data: defaults })
    await payload.delete({ collection: 'backups', where: { type: { equals: 'scheduled' } } })
  })

  test('does nothing while turned off', async () => {
    const result = await run('2026-11-01T03:05:00Z')
    expect(result.backup).toBeUndefined()
    expect(result.reason).toMatch(/turned off/)
  })

  test('takes daily, weekly and monthly backups and keeps the configured number', async () => {
    await payload.updateGlobal({
      slug: 'backup-settings',
      data: {
        daily: { enabled: true, keep: 2 },
        enabled: true,
        includeMedia: false,
        monthly: { day: 1, enabled: true, keep: 1 },
        time: '03:00',
        timezone: 'UTC',
        weekly: { day: 'sunday', enabled: true, keep: 1 },
      },
    })

    // Sunday the 1st: one backup counts for all three schedules.
    const first = await run('2026-11-01T03:05:00Z')
    expect(first.frequencies).toEqual(['daily', 'weekly', 'monthly'])
    expect(first.backup?.status).toBe('completed')

    // Nothing more is due until the next planned time.
    expect((await run('2026-11-01T09:00:00Z')).reason).toMatch(/No backup is due/)
    expect((await run('2026-11-02T02:59:00Z')).reason).toMatch(/No backup is due/)

    const monday = await run('2026-11-02T03:05:00Z')
    expect(monday.frequencies).toEqual(['daily'])
    await run('2026-11-03T03:05:00Z')
    const wednesday = await run('2026-11-04T03:05:00Z')
    expect(wednesday.deleted).toBe(1)

    // Kept: the two latest dailies, plus Sunday's backup for weekly and monthly.
    const kept = await scheduled()
    expect(kept.map((doc) => doc.startedAt)).toEqual([
      '2026-11-04T03:05:00.000Z',
      '2026-11-03T03:05:00.000Z',
      '2026-11-01T03:05:00.000Z',
    ])
    expect(await inStorage(monday.backup!.filename)).toBe(false)

    // Next Sunday's weekly replaces the old one; the monthly backup stays.
    const sunday = await run('2026-11-08T03:05:00Z')
    expect(sunday.frequencies).toEqual(['daily', 'weekly'])
    const afterSunday = await scheduled()
    expect(afterSunday.map((doc) => doc.startedAt)).toContain('2026-11-01T03:05:00.000Z')
    expect(afterSunday).toHaveLength(3)
  })

  test('the cron endpoint requires the secret', async () => {
    const denied = await buildRequest({
      headers: { Authorization: 'Bearer wrong' },
      url: '/cron',
      withUser: false,
    })
    expect((await getEndpoint('/cron', 'get').handler(denied)).status).toBe(401)

    const allowed = await buildRequest({
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      url: '/cron',
      withUser: false,
    })
    const response = await getEndpoint('/cron', 'get').handler(allowed)
    expect(response.status).toBe(200)
    expect((await response.json()).message).toBeTruthy()
  })

  test('the health check reports late and failed scheduled backups', async () => {
    const options = getOptions(payload)
    // Backups ran up to 2026-11-08 03:05 (the tests above).
    const healthy = await getBackupHealth(payload)
    expect(typeof healthy.ok).toBe('boolean')
    const onTime = await (await import('../src/core/health.js')).getBackupHealth({
      now: new Date('2026-11-08T04:00:00Z'),
      options,
      payload,
    })
    expect(onTime.problems).toEqual([])
    expect(onTime.ok).toBe(true)

    // Two days later nothing has run: the daily backup is overdue.
    const late = await (await import('../src/core/health.js')).getBackupHealth({
      now: new Date('2026-11-10T06:00:00Z'),
      options,
      payload,
    })
    expect(late.ok).toBe(false)
    expect(late.problems.join(' ')).toMatch(/daily backup planned for 2026-11-10T03:00:00.000Z has not completed/)

    const req = await buildRequest({
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      url: '/health',
      withUser: false,
    })
    const response = await getEndpoint('/health', 'get').handler(req)
    expect([200, 503]).toContain(response.status)
    expect((await response.json()).schedules).toBeDefined()
  })

  test('waits while a restore runs, and a restore keeps the schedule', async () => {
    const [backup] = await scheduled()
    await payload.updateGlobal({ slug: 'backup-settings', data: { daily: { enabled: true, keep: 5 } } })

    const restoring = restoreBackup(payload, backup.id, { user })
    expect((await run('2026-11-09T03:05:00Z')).reason).toMatch(/restore is in progress/)
    await restoring

    // The backup was taken while daily backups kept 2; the settings changed since.
    const settings = await payload.findGlobal({ slug: 'backup-settings' })
    expect(settings.enabled).toBe(true)
    expect(settings.daily?.keep).toBe(5)
  })
})
