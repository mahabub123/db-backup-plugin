import type { CollectionConfig } from 'payload'

import type { SanitizedBackupPluginConfig } from '../types.js'

import { createBackupEndpoints } from '../endpoints/index.js'

export const createBackupsCollection = ({
  adminGroup,
  disabled,
  options,
}: {
  adminGroup: string
  disabled: boolean
  options: SanitizedBackupPluginConfig
}): CollectionConfig => ({
  slug: options.slug,
  access: {
    // Backups are only created through the plugin's endpoints, jobs and API.
    create: () => false,
    delete: options.access,
    read: options.access,
    update: () => false,
  },
  admin: {
    components: disabled
      ? undefined
      : {
          beforeListTable: [
            {
              clientProps: { backupsSlug: options.slug },
              path: 'payload-plugin-backup/client#BackupListActions',
            },
          ],
        },
    defaultColumns: ['filename', 'status', 'type', 'frequencies', 'size', 'createdAt', 'export'],
    description:
      'Complete backups of the database and uploaded files. Open a backup to download or restore it.',
    group: adminGroup,
    useAsTitle: 'filename',
  },
  endpoints: disabled ? [] : createBackupEndpoints(options),
  fields: [
    {
      name: 'actions',
      type: 'ui',
      admin: {
        components: {
          Field: 'payload-plugin-backup/client#BackupDocumentActions',
        },
        condition: () => !disabled,
        disableListColumn: true,
      },
    },
    {
      name: 'export',
      type: 'ui',
      admin: {
        components: {
          Cell: 'payload-plugin-backup/client#BackupExportCell',
          Field: false,
        },
        condition: () => !disabled,
      },
      label: 'Export',
    },
    {
      name: 'filename',
      type: 'text',
      admin: { readOnly: true },
      index: true,
      required: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          admin: { readOnly: true },
          defaultValue: 'running',
          index: true,
          options: [
            { label: 'Running', value: 'running' },
            { label: 'Completed', value: 'completed' },
            { label: 'Failed', value: 'failed' },
          ],
          required: true,
        },
        {
          name: 'type',
          type: 'select',
          admin: { readOnly: true },
          defaultValue: 'manual',
          options: [
            { label: 'Manual', value: 'manual' },
            { label: 'Scheduled', value: 'scheduled' },
            { label: 'Before restore', value: 'pre-restore' },
            { label: 'Imported', value: 'imported' },
            { label: 'Found in storage', value: 'found' },
          ],
          required: true,
        },
      ],
    },
    {
      name: 'frequencies',
      type: 'select',
      admin: {
        condition: (data) => data?.type === 'scheduled',
        description: 'The automatic schedules this backup counts for.',
        readOnly: true,
      },
      hasMany: true,
      options: [
        { label: 'Daily', value: 'daily' },
        { label: 'Weekly', value: 'weekly' },
        { label: 'Monthly', value: 'monthly' },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'size',
          type: 'number',
          admin: {
            components: { Cell: 'payload-plugin-backup/client#BackupSizeCell' },
            description: 'Archive size in bytes.',
            readOnly: true,
          },
        },
        {
          name: 'documents',
          type: 'number',
          admin: { readOnly: true },
        },
        {
          name: 'files',
          type: 'number',
          admin: { description: 'Uploaded files in the archive.', readOnly: true },
        },
      ],
    },
    {
      name: 'error',
      type: 'textarea',
      admin: {
        condition: (data) => Boolean(data?.error),
        readOnly: true,
      },
    },
    {
      name: 'manifest',
      type: 'json',
      admin: {
        description: 'What the archive contains, per collection and global.',
        readOnly: true,
      },
    },
    {
      name: 'includesMedia',
      type: 'checkbox',
      admin: { position: 'sidebar', readOnly: true },
      label: 'Includes media files',
    },
    {
      name: 'storage',
      type: 'text',
      admin: { position: 'sidebar', readOnly: true },
    },
    {
      name: 'importedFrom',
      type: 'text',
      admin: {
        condition: (data) => Boolean(data?.importedFrom),
        description: 'Name of the uploaded file.',
        position: 'sidebar',
        readOnly: true,
      },
    },
    {
      name: 'createdBy',
      type: 'text',
      admin: { position: 'sidebar', readOnly: true },
    },
    ...(['startedAt', 'completedAt', 'restoredAt'] as const).map((name) => ({
      name,
      type: 'date' as const,
      admin: {
        date: { displayFormat: 'PPpp' },
        position: 'sidebar' as const,
        readOnly: true,
      },
      index: name === 'startedAt',
    })),
    {
      name: 'checksum',
      type: 'text',
      admin: { description: 'SHA-256 of the archive.', position: 'sidebar', readOnly: true },
    },
  ],
  hooks: {
    afterDelete: [
      async ({ doc, req }) => {
        if (!doc?.filename) {
          return
        }
        try {
          await options.storage.delete({ filename: doc.filename as string })
        } catch (error) {
          req.payload.logger.error({
            err: error,
            msg: `[payload-plugin-backup] Could not delete archive ${String(doc.filename)}`,
          })
        }
      },
    ],
  },
  labels: { plural: 'Backups', singular: 'Backup' },
})
