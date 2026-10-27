import type { Payload } from 'payload'

import type { SanitizedBackupPluginConfig } from '../types.js'

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
  const expired = docs.filter(
    (doc, index) =>
      (maxBackups && index >= maxBackups) ||
      (cutoff && new Date(doc.createdAt as string).getTime() < cutoff),
  )

  for (const doc of expired) {
    await payload.delete({ id: doc.id, collection: options.slug, overrideAccess: true })
  }

  return expired.length
}
