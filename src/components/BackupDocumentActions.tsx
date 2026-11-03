'use client'
import { Button, toast, useConfig, useDocumentInfo, useFormFields, useModal } from '@payloadcms/ui'
import { useRouter } from 'next/navigation.js'
import { formatAdminURL } from 'payload/shared'
import React, { useState } from 'react'

import { RestoreModal } from './RestoreModal.js'
import { readError } from './shared.js'

const RESTORE_MODAL = 'payload-plugin-backup-restore'

/** Backups this site made itself: their checksum in the database vouches for them. */
const LOCAL_TYPES = ['manual', 'pre-restore', 'scheduled']

/** Export, Verify and Restore buttons on a single backup. */
export const BackupDocumentActions = () => {
  const { config } = useConfig()
  const router = useRouter()
  const { id, collectionSlug } = useDocumentInfo()
  const { openModal } = useModal()
  const [verifying, setVerifying] = useState(false)
  const status = useFormFields(([fields]) => fields.status?.value)
  const filename = useFormFields(([fields]) => fields.filename?.value) as string | undefined
  const signed = useFormFields(([fields]) => fields.signed?.value) as boolean | undefined
  const type = useFormFields(([fields]) => fields.type?.value) as string | undefined
  const checksum = useFormFields(([fields]) => fields.checksum?.value) as string | undefined

  if (!id || !collectionSlug || status !== 'completed') {
    return null
  }

  const url = (path: `/${string}`) => formatAdminURL({ apiRoute: config.routes.api, path })
  const unverified = !signed && !(checksum && type && LOCAL_TYPES.includes(type))

  const verify = async () => {
    setVerifying(true)
    const pending = toast.loading('Downloading and checking the backup…')
    try {
      const response = await fetch(url(`/${collectionSlug}/${id}/verify`), {
        credentials: 'include',
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error(await readError(response))
      }
      const { verification } = (await response.json()) as {
        verification: { errors: string[]; ok: boolean; warnings: string[] }
      }
      if (verification.ok) {
        toast.success(
          `The backup is complete and can be restored.${verification.warnings.length ? ` ${verification.warnings[0]}` : ''}`,
          { id: pending },
        )
      } else {
        toast.error(`The backup has problems: ${verification.errors[0]}`, { id: pending })
      }
      router.refresh()
    } catch (error) {
      toast.error(`Verification failed: ${(error as Error).message}`, { id: pending })
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'calc(var(--base) * 0.5)',
        marginBottom: 'var(--base)',
      }}
    >
      <Button
        buttonStyle="primary"
        el="anchor"
        margin={false}
        newTab={false}
        url={url(`/${collectionSlug}/${id}/download`)}
      >
        Export (download)
      </Button>
      <Button buttonStyle="secondary" disabled={verifying} margin={false} onClick={verify}>
        {verifying ? 'Verifying…' : 'Verify'}
      </Button>
      <Button buttonStyle="secondary" margin={false} onClick={() => openModal(RESTORE_MODAL)}>
        Restore…
      </Button>
      <RestoreModal
        backupsSlug={collectionSlug}
        filename={filename}
        id={id}
        modalSlug={RESTORE_MODAL}
        unverified={unverified}
      />
    </div>
  )
}
