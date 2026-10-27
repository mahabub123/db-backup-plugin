import type { Payload, SanitizedCollectionConfig, SanitizedGlobalConfig } from 'payload'

import type { SanitizedBackupPluginConfig } from '../types.js'

/**
 * Payload's own bookkeeping collections that must never be overwritten by a
 * restore: jobs and locks are runtime state, and migrations describe the
 * schema of the *current* database, not the one in the archive.
 */
export const INTERNAL_COLLECTIONS = [
  'payload-jobs',
  'payload-locked-documents',
  'payload-migrations',
]

const filterBySlug = <T extends { slug: string }>(
  items: T[],
  { exclude, include }: { exclude: string[]; include?: string[] },
): T[] =>
  items.filter(({ slug }) => !exclude.includes(slug) && (!include || include.includes(slug)))

export const getBackupCollections = (
  payload: Payload,
  options: SanitizedBackupPluginConfig,
): SanitizedCollectionConfig[] =>
  filterBySlug(
    payload.config.collections.filter(
      ({ slug }) => slug !== options.slug && !INTERNAL_COLLECTIONS.includes(slug),
    ),
    options.collections,
  )

/**
 * The plugin's own Backup Settings are left out: restoring an older backup must
 * not change (or turn off) the schedule that protects the site.
 */
export const getBackupGlobals = (
  payload: Payload,
  options: SanitizedBackupPluginConfig,
): SanitizedGlobalConfig[] =>
  filterBySlug(
    payload.config.globals.filter(({ slug }) => slug !== options.settingsSlug),
    options.globals,
  )

export const getMediaCollections = (
  payload: Payload,
  options: SanitizedBackupPluginConfig,
): SanitizedCollectionConfig[] => {
  if (!options.media.enabled) {
    return []
  }
  return getBackupCollections(payload, options).filter(
    (collection) =>
      Boolean(collection.upload) &&
      (!options.media.collections || options.media.collections.includes(collection.slug)),
  )
}
