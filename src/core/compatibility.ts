import type { Payload } from 'payload'

import type { BackupManifest, SanitizedBackupPluginConfig } from '../types.js'

import { getPackageVersions } from '../utilities/versions.js'
import { getAdapterKind, getDatabaseKind } from './database.js'
import { getBackupCollections, getBackupGlobals } from './entities.js'

export type Compatibility = {
  /** Reasons the archive cannot be restored on this site. */
  errors: string[]
  /** Things that will be different after a restore, but don't block it. */
  warnings: string[]
}

/** Compares an archive's manifest with the site it is about to be restored on. */
export const checkCompatibility = ({
  manifest,
  options,
  payload,
}: {
  manifest: BackupManifest
  options: SanitizedBackupPluginConfig
  payload: Payload
}): Compatibility => {
  const errors: string[] = []
  const warnings: string[] = []

  if (manifest.formatVersion !== 1) {
    errors.push(`Unsupported backup format version: ${String(manifest.formatVersion)}.`)
  }

  const archiveKind = getAdapterKind(manifest.databaseAdapter ?? '')
  const siteKind = getDatabaseKind(payload)
  if (archiveKind !== 'other' && siteKind !== 'other' && archiveKind !== siteKind) {
    errors.push(
      `This backup was taken from a ${archiveKind} database and this site uses ${siteKind}. Document ids are not compatible between the two, so it can only be restored on a ${archiveKind} site.`,
    )
  }

  const collections = new Set(getBackupCollections(payload, options).map(({ slug }) => slug))
  const missingCollections = manifest.collections
    .map(({ slug }) => slug)
    .filter((slug) => !collections.has(slug))
  if (missingCollections.length) {
    warnings.push(
      `Not restored because this site has no such collection: ${missingCollections.join(', ')}.`,
    )
  }

  const globals = new Set(getBackupGlobals(payload, options).map(({ slug }) => slug))
  // Archives made by 1.0.x include the Backup Settings, which are never restored.
  const missingGlobals = manifest.globals
    .map(({ slug }) => slug)
    .filter((slug) => !globals.has(slug) && slug !== options.settingsSlug)
  if (missingGlobals.length) {
    warnings.push(`Not restored because this site has no such global: ${missingGlobals.join(', ')}.`)
  }

  const archiveMajor = manifest.payloadVersion?.split('.')[0]
  const { payloadVersion } = getPackageVersions()
  if (payloadVersion !== 'unknown' && archiveMajor && archiveMajor !== payloadVersion.split('.')[0]) {
    warnings.push(
      `The backup was taken with Payload ${manifest.payloadVersion}; this site runs ${payloadVersion}.`,
    )
  }

  return { errors, warnings }
}
