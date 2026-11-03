import type { Payload, Where } from 'payload'

import type { BackupRecord, SanitizedBackupPluginConfig } from '../types.js'

const DAY = 24 * 60 * 60 * 1000

/**
 * Deletes completed backups (except scheduled ones) beyond `retention.maxBackups` or older than
 * `retention.maxAgeDays`. The archive itself is removed from storage by the
 * collection's afterDelete hook.
 */
export const applyRetention = async ({
  options,
  payload,
}: {
  options: SanitizedBackupPluginConfig
  payload: Payload
}): Promise<number> => {
  const { maxAgeDays, maxBackups } = options.retention ?? {}
  if (!maxAgeDays && !maxBackups) {
    return 0
  }

  const { docs } = await payload.find({
    collection: options.slug,
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    sort: '-createdAt',
    // Scheduled backups follow the keep counts in Backup Settings instead.
    where: { and: [{ status: { equals: 'completed' } }, { type: { not_equals: 'scheduled' } }] },
  })

  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * DAY : undefined
  // Never delete the newest backup known to restore cleanly.
  const verified = await findNewestVerified({
    options,
    payload,
    where: { type: { not_equals: 'scheduled' } },
  })
  const expired = docs.filter(
    (doc, index) =>
      doc.id !== verified?.id &&
      ((maxBackups && index >= maxBackups) ||
        (cutoff && new Date(doc.createdAt as string).getTime() < cutoff)),
  )

  for (const doc of expired) {
    await payload.delete({ id: doc.id, collection: options.slug, overrideAccess: true })
  }

  return expired.length
}

/** The newest completed backup that passed verification, if any. */
export const findNewestVerified = async ({
  options,
  payload,
  where,
}: {
  options: SanitizedBackupPluginConfig
  payload: Payload
  where?: Where
}): Promise<BackupRecord | undefined> => {
  const { docs } = await payload.find({
    collection: options.slug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    sort: '-startedAt',
    where: {
      and: [{ status: { equals: 'completed' } }, { verified: { equals: true } }, ...(where ? [where] : [])],
    },
  })
  return docs[0] as unknown as BackupRecord | undefined
}
