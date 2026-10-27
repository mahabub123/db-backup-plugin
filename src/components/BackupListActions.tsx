'use client'
import { Button, toast, useConfig, useModal } from '@payloadcms/ui'
import { useRouter } from 'next/navigation.js'
import { formatAdminURL } from 'payload/shared'
import React, { useRef, useState } from 'react'

import { RestoreModal } from './RestoreModal.js'
import { formatBytes, readError } from './shared.js'

const IMPORT_MODAL = 'payload-plugin-backup-imported'

const wrapperStyle: React.CSSProperties = {
  alignItems: 'center',
  border: '1px solid var(--theme-elevation-150)',
  borderRadius: 'var(--style-radius-m)',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'calc(var(--base) * 0.75)',
  marginBottom: 'var(--base)',
  padding: 'calc(var(--base) * 0.75) var(--base)',
}

type ImportedBackup = {
  documents?: number
  filename: string
  files?: number
  id: number | string
  importedFrom?: string
  size?: number
  warnings: string[]
}

/** Back up, export and import controls shown above the backups list. */
export const BackupListActions = ({ backupsSlug = 'backups' }: { backupsSlug?: string }) => {
  const { config } = useConfig()
  const router = useRouter()
  const { openModal } = useModal()
  const fileInput = useRef<HTMLInputElement>(null)
  const [includeMedia, setIncludeMedia] = useState(true)
  const [busy, setBusy] = useState<'backup' | 'export' | 'import' | 'sync' | null>(null)
  const [imported, setImported] = useState<ImportedBackup | null>(null)

  const url = (path: string) =>
    formatAdminURL({ apiRoute: config.routes.api, path: `/${backupsSlug}${path}` })

  const runBackup = async (exportAfter: boolean) => {
    setBusy(exportAfter ? 'export' : 'backup')
    try {
      const response = await fetch(url('/run'), {
        body: JSON.stringify({ includeMedia }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error(await readError(response))
      }
      const { doc } = (await response.json()) as { doc: { id: number | string } }
      if (exportAfter) {
        // The download endpoint answers with Content-Disposition: attachment,
        // so the browser saves the file and stays on this page.
        window.location.assign(url(`/${doc.id}/download`))
        toast.success('Backup created. Your download is starting.')
      } else {
        toast.success('Backup created.')
      }
    } catch (error) {
      toast.error(`Backup failed: ${(error as Error).message}`)
    } finally {
      setBusy(null)
      router.refresh()
    }
  }

  const findInStorage = async () => {
    setBusy('sync')
    try {
      const response = await fetch(url('/sync'), { credentials: 'include', method: 'POST' })
      if (!response.ok) {
        throw new Error(await readError(response))
      }
      const { message, skipped } = (await response.json()) as {
        message: string
        skipped: { filename: string; reason: string }[]
      }
      toast.success(message)
      for (const { filename, reason } of skipped) {
        toast.warning(`Skipped ${filename}: ${reason}`)
      }
    } catch (error) {
      toast.error(`Could not read storage: ${(error as Error).message}`)
    } finally {
      setBusy(null)
      router.refresh()
    }
  }

  const importFile = async (file: File) => {
    setBusy('import')
    try {
      const response = await fetch(url(`/import?filename=${encodeURIComponent(file.name)}`), {
        body: file,
        credentials: 'include',
        headers: { 'Content-Type': 'application/gzip' },
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error(await readError(response))
      }
      const { doc, warnings } = (await response.json()) as {
        doc: Omit<ImportedBackup, 'warnings'>
        warnings: string[]
      }
      setImported({ ...doc, warnings })
      openModal(IMPORT_MODAL)
    } catch (error) {
      toast.error(`Import failed: ${(error as Error).message}`)
    } finally {
      setBusy(null)
      if (fileInput.current) {
        fileInput.current.value = ''
      }
      router.refresh()
    }
  }

  return (
    <div style={wrapperStyle}>
      <Button
        buttonStyle="primary"
        disabled={busy !== null}
        margin={false}
        onClick={() => runBackup(false)}
      >
        {busy === 'backup' ? 'Backing up…' : 'Back up now'}
      </Button>
      <Button
        buttonStyle="secondary"
        disabled={busy !== null}
        margin={false}
        onClick={() => runBackup(true)}
      >
        {busy === 'export' ? 'Preparing export…' : 'Export new backup'}
      </Button>
      <label style={{ alignItems: 'center', display: 'flex', gap: 6 }}>
        <input
          aria-label="Include uploaded files"
          checked={includeMedia}
          disabled={busy !== null}
          onChange={(event) => setIncludeMedia(event.target.checked)}
          type="checkbox"
        />
        Include uploaded files
      </label>
      <span style={{ flex: 1 }} />
      <Button
        buttonStyle="subtle"
        disabled={busy !== null}
        margin={false}
        onClick={findInStorage}
        tooltip="Adds archives that are in storage (e.g. your S3/R2 bucket) but missing from this list."
      >
        {busy === 'sync' ? 'Searching…' : 'Find backups in storage'}
      </Button>
      <input
        accept=".gz,.tgz,application/gzip"
        aria-label="Backup file to import"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            void importFile(file)
          }
        }}
        ref={fileInput}
        type="file"
      />
      <Button
        buttonStyle="secondary"
        disabled={busy !== null}
        margin={false}
        onClick={() => fileInput.current?.click()}
      >
        {busy === 'import' ? 'Uploading…' : 'Import backup…'}
      </Button>
      {imported && (
        <RestoreModal
          backupsSlug={backupsSlug}
          cancelLabel="Keep for later"
          filename={imported.importedFrom ?? imported.filename}
          heading="Backup imported"
          id={imported.id}
          intro={
            <p style={{ margin: 0 }}>
              The file was checked and added to the list ({imported.documents ?? 0} documents,{' '}
              {imported.files ?? 0} files, {formatBytes(imported.size)}). Restore it now, or keep
              it and restore it later from the list.
            </p>
          }
          modalSlug={IMPORT_MODAL}
          warnings={imported.warnings}
        />
      )}
    </div>
  )
}
