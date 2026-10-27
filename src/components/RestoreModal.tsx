'use client'
import { ConfirmationModal, toast, useConfig } from '@payloadcms/ui'
import { formatAdminURL } from 'payload/shared'
import React, { useState } from 'react'

import { readError } from './shared.js'

export const RESTORE_CONFIRMATION = 'RESTORE'

type Props = {
  backupsSlug: string
  cancelLabel?: string
  filename?: string
  heading?: string
  id: number | string
  /** Shown above the confirmation, e.g. what was just imported. */
  intro?: React.ReactNode
  modalSlug: string
  warnings?: string[]
}

/**
 * Asks the user to type RESTORE, then restores the backup and reloads the
 * admin panel (users may have been restored too).
 */
export const RestoreModal = ({
  id,
  backupsSlug,
  cancelLabel,
  filename,
  heading = 'Restore this backup?',
  intro,
  modalSlug,
  warnings = [],
}: Props) => {
  const { config } = useConfig()
  const [typed, setTyped] = useState('')

  const restore = async () => {
    if (typed.trim() !== RESTORE_CONFIRMATION) {
      toast.error(`Type ${RESTORE_CONFIRMATION} to confirm the restore.`)
      return
    }
    const pending = toast.loading('Restoring backup… do not close this page.')
    try {
      const response = await fetch(
        formatAdminURL({ apiRoute: config.routes.api, path: `/${backupsSlug}/${id}/restore` }),
        {
          body: JSON.stringify({ confirm: RESTORE_CONFIRMATION }),
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      )
      if (!response.ok) {
        throw new Error(await readError(response))
      }
      toast.success('Backup restored. Reloading…', { id: pending })
      window.setTimeout(() => window.location.assign(config.routes.admin), 1200)
    } catch (error) {
      toast.error(`Restore failed: ${(error as Error).message}`, { id: pending })
    } finally {
      setTyped('')
    }
  }

  return (
    <ConfirmationModal
      body={
        <div style={{ display: 'grid', gap: 'calc(var(--base) * 0.5)' }}>
          {intro}
          {warnings.length > 0 && (
            <ul style={{ color: 'var(--theme-warning-650)', margin: 0, paddingLeft: '1.2em' }}>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <p style={{ margin: 0 }}>
            Restoring {filename ? <strong>{filename}</strong> : 'this backup'} replaces{' '}
            <strong>all</strong> documents, globals, users and uploaded files with the content of
            the backup. A backup of the current state is taken first, unless that was turned off.
          </p>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>
              Type <code>{RESTORE_CONFIRMATION}</code> to restore now.
            </span>
            <input
              aria-label={`Type ${RESTORE_CONFIRMATION} to restore now.`}
              autoComplete="off"
              className="input"
              onChange={(event) => setTyped(event.target.value)}
              style={{ padding: '6px 8px', width: '100%' }}
              value={typed}
            />
          </label>
        </div>
      }
      cancelLabel={cancelLabel}
      confirmingLabel="Restoring…"
      confirmLabel="Restore now"
      heading={heading}
      modalSlug={modalSlug}
      onCancel={() => setTyped('')}
      onConfirm={restore}
    />
  )
}
