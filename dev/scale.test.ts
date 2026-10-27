import type { Payload } from 'payload'

import config from '@payload-config'
import crypto from 'crypto'
import { getPayload } from 'payload'
import { createBackup, restoreBackup } from 'payload-plugin-backup'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

/**
 * Backs up and restores a large generated site and checks that every document
 * and version comes back unchanged. Off by default because it takes minutes:
 *   SCALE_DOCS=20000 pnpm vitest run dev/scale.test.ts
 */
const total = Number(process.env.SCALE_DOCS || 0)

let payload: Payload

/** Runs `task` and reports how long it took and how far memory use grew. */
const measure = async <T>(label: string, task: () => Promise<T>): Promise<T> => {
  const before = process.memoryUsage().rss
  let peak = before
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 50)
  const started = performance.now()
  try {
    return await task()
  } finally {
    clearInterval(timer)
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    const grew = ((peak - before) / 1024 / 1024).toFixed(0)
    console.log(`[scale] ${label}: ${seconds}s, memory +${grew} MB (peak ${(peak / 1024 / 1024).toFixed(0)} MB)`)
  }
}

/** JSON with sorted keys: the database may return localized values in any order. */
const stableJSON = (value: unknown): string =>
  JSON.stringify(value, (_key, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  )

/** A fingerprint of every post and post version, straight from the database. */
const fingerprint = async () => {
  const hash = crypto.createHash('sha256')
  let docs = 0
  for (let page = 1; ; page++) {
    const result = await payload.db.find({
      collection: 'posts',
      limit: 1000,
      page,
      pagination: true,
      sort: 'id',
    })
    for (const doc of result.docs) {
      hash.update(stableJSON(doc))
      docs++
    }
    if (!result.hasNextPage) {
      break
    }
  }
  const versions = await payload.db.countVersions({ collection: 'posts', where: {} })
  return { docs, hash: hash.digest('hex'), versions: versions.totalDocs }
}

const runInParallel = async (count: number, task: (index: number) => Promise<unknown>) => {
  let next = 0
  await Promise.all(
    Array.from({ length: 25 }, async () => {
      while (next < count) {
        await task(next++)
      }
    }),
  )
}

describe.skipIf(!total)('large site', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  test(
    `backs up and restores ${total} posts with their versions`,
    async () => {
      const categories = await Promise.all(
        ['News', 'Guides', 'Releases'].map((title) =>
          payload.create({ collection: 'categories', data: { title } }),
        ),
      )
      const author = (await payload.find({ collection: 'users', limit: 1 })).docs[0]

      await measure(`seeding ${total} posts`, () =>
        runInParallel(total, async (i) => {
          const post = await payload.create({
            collection: 'posts',
            data: {
              _status: 'draft',
              author: author.id,
              categories: [categories[i % 3].id, categories[(i + 1) % 3].id],
              layout: [
                { blockType: 'callToAction', label: `Read post ${i}`, link: `/posts/${i}` },
                { blockType: 'callToAction', label: 'Subscribe', link: '/subscribe' },
              ],
              tags: [{ tag: 'payload' }, { tag: `tag-${i % 50}` }, { tag: 'backup' }],
              title: `Post number ${i} with a reasonably long title`,
            },
            draft: true,
          })
          await payload.update({
            id: post.id,
            collection: 'posts',
            data: { _status: 'published', title: `Título ${i}` },
            locale: 'es',
          })
        }),
      )

      const original = await fingerprint()
      expect(original.docs).toBe(total)

      const backup = await measure('backup', () => createBackup(payload, { includeMedia: false }))
      console.log(`[scale] archive: ${((backup.size as number) / 1024 / 1024).toFixed(1)} MB`)

      // Lose half of the content, then bring it back.
      await payload.db.deleteMany({
        collection: 'posts',
        where: { id: { in: (await payload.db.find({ collection: 'posts', limit: Math.floor(total / 2), pagination: false })).docs.map((doc) => doc.id) } },
      })
      expect((await fingerprint()).docs).toBeLessThan(total)

      await measure('restore', () => restoreBackup(payload, backup.id))

      expect(await fingerprint()).toEqual(original)
    },
    60 * 60 * 1000,
  )
})
