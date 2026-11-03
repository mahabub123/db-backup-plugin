import type { Block, Field, Payload } from 'payload'

import fsp from 'fs/promises'
import path from 'path'

import type { BackupManifest, BackupRecord, SanitizedBackupPluginConfig } from '../types.js'

import { checkCompatibility } from './compatibility.js'
import { getDatabaseKind } from './database.js'
import { getBackupCollections } from './entities.js'
import { checkArchiveContents, isSignedBySite } from './integrity.js'
import { fileExists } from './media.js'
import { readNdjson } from './ndjson.js'
import { readManifest, unpackStoredBackup } from './restoreBackup.js'
import { assertSameStorage } from './storageCheck.js'

export type VerificationResult = {
  checkedAt: string
  /** Documents read from the archive. */
  documents: number
  /** Reasons the backup could not be restored as it is. */
  errors: string[]
  ok: boolean
  /** Whether the archive is signed by this site. */
  signed: boolean
  /** Things worth knowing that don't stop a restore. */
  warnings: string[]
}

const MAX_LISTED = 20

type RefSink = (collection: string, id: number | string) => void

/** Ids as stored: numbers (SQL), strings (MongoDB, custom ids) or ObjectId-like values. */
const toID = (value: unknown): number | string | undefined =>
  typeof value === 'number' || typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'toString' in value
      ? (value as { toString: () => string }).toString()
      : undefined

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Calls `sink` for every relationship and upload value stored in `data`,
 * walking groups, arrays, blocks, tabs and localized values.
 */
const collectReferences = ({
  blocks,
  data,
  fields,
  locales,
  sink,
}: {
  blocks: Map<string, Block>
  data: unknown
  fields: Field[]
  locales: Set<string>
  sink: RefSink
}): void => {
  if (!isPlainObject(data)) {
    return
  }

  /** `{ en: ..., es: ... }` of a localized field (or of a field inside a localized parent). */
  const forEachLocale = (value: unknown, visit: (value: unknown) => void) => {
    if (
      locales.size &&
      isPlainObject(value) &&
      Object.keys(value).length > 0 &&
      Object.keys(value).every((key) => locales.has(key))
    ) {
      Object.values(value).forEach(visit)
    } else {
      visit(value)
    }
  }

  for (const field of fields) {
    const named = 'name' in field && field.name ? (field.name) : undefined

    switch (field.type) {
      case 'array': {
        forEachLocale(named ? data[named] : undefined, (rows) => {
          for (const row of Array.isArray(rows) ? rows : []) {
            collectReferences({ blocks, data: row, fields: field.fields, locales, sink })
          }
        })
        break
      }
      case 'blocks': {
        forEachLocale(named ? data[named] : undefined, (rows) => {
          for (const row of Array.isArray(rows) ? rows : []) {
            const blockType = isPlainObject(row) ? row.blockType : undefined
            const block =
              field.blocks.find(({ slug }) => slug === blockType) ??
              (typeof blockType === 'string' ? blocks.get(blockType) : undefined)
            if (block) {
              collectReferences({ blocks, data: row, fields: block.fields, locales, sink })
            }
          }
        })
        break
      }
      case 'collapsible':
      case 'row': {
        collectReferences({ blocks, data, fields: field.fields, locales, sink })
        break
      }
      case 'group': {
        if (named) {
          forEachLocale(data[named], (value) =>
            collectReferences({ blocks, data: value, fields: field.fields, locales, sink }),
          )
        } else {
          collectReferences({ blocks, data, fields: field.fields, locales, sink })
        }
        break
      }
      case 'relationship':
      case 'upload': {
        if (!named) {
          break
        }
        const relationTo = field.relationTo
        const visit = (value: unknown): void => {
          if (value === null || value === undefined || value === '') {
            return
          }
          if (Array.isArray(value)) {
            value.forEach(visit)
          } else if (isPlainObject(value) && 'relationTo' in value) {
            const id = toID(isPlainObject(value.value) ? value.value.id : value.value)
            if (id !== undefined) {
              sink(String(value.relationTo), id)
            }
          } else if (typeof relationTo === 'string') {
            const id = toID(isPlainObject(value) ? value.id : value)
            if (id !== undefined) {
              sink(relationTo, id)
            }
          }
        }
        forEachLocale(data[named], visit)
        break
      }
      case 'tabs': {
        for (const tab of field.tabs) {
          if ('name' in tab && tab.name) {
            forEachLocale(data[tab.name], (value) =>
              collectReferences({ blocks, data: value, fields: tab.fields, locales, sink }),
            )
          } else {
            collectReferences({ blocks, data, fields: tab.fields, locales, sink })
          }
        }
        break
      }
      default:
        break
    }
  }
}

/**
 * Checks a stored backup end to end without touching the site's content:
 * download, checksum, decryption, every file against the manifest, the
 * signature, every document line, the counts, and that relationships point to
 * documents inside the archive. The result is saved on the backup record.
 */
export const verifyBackup = async ({
  id,
  options,
  payload,
}: {
  id: number | string
  options: SanitizedBackupPluginConfig
  payload: Payload
}): Promise<VerificationResult> => {
  const backup = (await payload.findByID({
    id,
    collection: options.slug,
    depth: 0,
    overrideAccess: true,
  })) as unknown as BackupRecord
  if (backup.status !== 'completed') {
    throw new Error(`Backup ${backup.filename} is not complete and cannot be verified.`)
  }
  assertSameStorage(backup, options)

  const errors: string[] = []
  const warnings: string[] = []
  let documents = 0
  let signed = false

  await fsp.mkdir(options.tempDir, { recursive: true })
  const workDir = await fsp.mkdtemp(path.join(options.tempDir, 'payload-verify-'))
  try {
    const dir = await unpackStoredBackup({ backup, options, workDir })
    const manifest: BackupManifest = await readManifest(dir)

    errors.push(...checkCompatibility({ manifest, options, payload }).errors)

    if (manifest.checksums) {
      errors.push(...(await checkArchiveContents(dir, manifest.checksums)))
      signed = isSignedBySite(manifest, payload, options)
    }
    if (!signed) {
      warnings.push(
        manifest.checksums
          ? 'The archive is not signed by this site (made elsewhere or with another secret).'
          : 'The archive was made before file checksums and signatures existed (plugin before 1.2).',
      )
    }
    if (manifest.snapshot === false) {
      warnings.push(
        'The backup was not read from one consistent snapshot; documents changed while it ran may not match each other.',
      )
    }
    for (const media of manifest.media) {
      if (media.missing.length) {
        warnings.push(`${media.missing.length} file(s) of "${media.collection}" were already missing when the backup was taken.`)
      }
    }

    // Every line parses, the counts match, and every id is known for the reference check.
    const ids = new Map<string, Set<string>>()
    for (const entry of manifest.collections) {
      const seen = new Set<string>()
      ids.set(entry.slug, seen)
      const file = path.join(dir, 'collections', `${entry.slug}.ndjson`)
      let count = 0
      if (await fileExists(file)) {
        try {
          for await (const doc of readNdjson(file)) {
            seen.add(String(doc.id))
            count++
          }
        } catch (error) {
          errors.push(`collections/${entry.slug}.ndjson is not valid: ${(error as Error).message}`)
        }
      }
      if (count !== entry.count) {
        errors.push(`"${entry.slug}" has ${count} documents in the archive, but the manifest lists ${entry.count}.`)
      }
      documents += count

      const versionsFile = path.join(dir, 'versions', `${entry.slug}.ndjson`)
      if (entry.versions && (await fileExists(versionsFile))) {
        let versions = 0
        try {
          for await (const _version of readNdjson(versionsFile)) {
            versions++
          }
        } catch (error) {
          errors.push(`versions/${entry.slug}.ndjson is not valid: ${(error as Error).message}`)
        }
        if (versions !== entry.versions) {
          errors.push(`"${entry.slug}" has ${versions} versions in the archive, but the manifest lists ${entry.versions}.`)
        }
      }
    }

    // Relationships that point to documents missing from the archive.
    const locales = new Set(
      payload.config.localization
        ? payload.config.localization.locales.map((locale) =>
            typeof locale === 'string' ? locale : locale.code,
          )
        : [],
    )
    const blocks = new Map((payload.config.blocks ?? []).map((block) => [block.slug, block]))
    const dangling: string[] = []
    let danglingCount = 0
    for (const collection of getBackupCollections(payload, options)) {
      const file = path.join(dir, 'collections', `${collection.slug}.ndjson`)
      if (!ids.has(collection.slug) || !(await fileExists(file))) {
        continue
      }
      try {
        for await (const doc of readNdjson(file)) {
          collectReferences({
            blocks,
            data: doc,
            fields: collection.fields,
            locales,
            sink: (target, targetID) => {
              const known = ids.get(target)
              if (known && !known.has(String(targetID))) {
                danglingCount++
                if (dangling.length < MAX_LISTED) {
                  dangling.push(`${collection.slug} ${String(doc.id)} → ${target} ${String(targetID)}`)
                }
              }
            },
          })
        }
      } catch {
        // already reported above
      }
    }
    if (danglingCount) {
      const message = `${danglingCount} relationship(s) point to documents that are not in the archive: ${dangling.join('; ')}${danglingCount > dangling.length ? ' …' : ''}`
      // SQL databases check foreign keys at the end of a restore, which would fail.
      // MongoDB restores them as they are (broken links that already existed).
      if (getDatabaseKind(payload) === 'mongodb') {
        warnings.push(message)
      } else {
        errors.push(message)
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    await fsp.rm(workDir, { force: true, recursive: true })
  }

  const result: VerificationResult = {
    checkedAt: new Date().toISOString(),
    documents,
    errors: errors.slice(0, MAX_LISTED),
    ok: errors.length === 0,
    signed,
    warnings: warnings.slice(0, MAX_LISTED),
  }

  await payload.update({
    id,
    collection: options.slug,
    data: { verification: result, verified: result.ok, verifiedAt: result.checkedAt },
    overrideAccess: true,
  })

  if (result.ok) {
    payload.logger.info(`[payload-plugin-backup] Verified ${backup.filename}: ${documents} documents, no problems.`)
  } else {
    payload.logger.error(
      `[payload-plugin-backup] Backup ${backup.filename} failed verification: ${result.errors.join(' ')}`,
    )
  }
  return result
}
