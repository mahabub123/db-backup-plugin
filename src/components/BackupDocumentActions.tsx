'use client'
import { Button, useConfig, useDocumentInfo, useFormFields, useModal } from '@payloadcms/ui'
import { formatAdminURL } from 'payload/shared'
import React from 'react'

import { RestoreModal } from './RestoreModal.js'

const RESTORE_MODAL = 'payload-plugin-backup-restore'

/** Export and Restore buttons on a single backup. */
export const BackupDocumentActions = () => {
  const { config } = useConfig()
  const { id, collectionSlug } = useDocumentInfo()
  const { openModal } = useModal()
  const status = useFormFields(([fields]) => fields.status?.value)
  const filename = useFormFields(([fields]) => fields.filename?.value) as string | undefined

  if (!id || !collectionSlug || status !== 'completed') {
    return null
  }

  const exportURL = formatAdminURL({
    apiRoute: config.routes.api,
    path: `/${collectionSlug}/${id}/download`,
  })

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'calc(var(--base) * 0.5)',
        marginBottom: 'var(--base)',
      }}
    >
      <Button buttonStyle="primary" el="anchor" margin={false} newTab={false} url={exportURL}>
        Export (download .tar.gz)
      </Button>
      <Button buttonStyle="secondary" margin={false} onClick={() => openModal(RESTORE_MODAL)}>
        Restore…
      </Button>
      <RestoreModal backupsSlug={collectionSlug} filename={filename} id={id} modalSlug={RESTORE_MODAL} />
    </div>
  )
}
