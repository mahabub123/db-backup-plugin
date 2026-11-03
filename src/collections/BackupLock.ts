import type { CollectionConfig } from 'payload'

import type { SanitizedBackupPluginConfig } from '../types.js'

/**
 * Holds at most one row: the lease of the backup or restore currently running
 * on any server. Its fixed id makes taking the lease atomic on every database
 * (a second insert fails on the primary key). Hidden, and only written through
 * the database adapter.
 *
 * `lockDocuments: false` keeps it out of Payload's locked-documents relations,
 * so it has no foreign keys and can be written while a restore holds locks on
 * every other table.
 */
export const createBackupLockCollection = ({
  options,
}: {
  options: SanitizedBackupPluginConfig
}): CollectionConfig => ({
  slug: options.lockSlug,
  access: {
    create: () => false,
    delete: () => false,
    read: () => false,
    update: () => false,
  },
  admin: { hidden: true },
  fields: [
    { name: 'id', type: 'text', required: true },
    { name: 'task', type: 'text' },
    { name: 'owner', type: 'text' },
    /** Milliseconds since 1970; numbers compare exactly on every database. */
    { name: 'startedAt', type: 'number' },
    { name: 'heartbeatAt', type: 'number' },
  ],
  graphQL: false,
  lockDocuments: false,
  timestamps: false,
})
