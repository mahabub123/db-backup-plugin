'use client'
import type { DefaultCellComponentProps } from 'payload'

import { useConfig } from '@payloadcms/ui'
import { formatAdminURL } from 'payload/shared'

/** "Export" link in the backups list, so archives can be downloaded without opening them. */
export const BackupExportCell = ({ collectionSlug, rowData }: DefaultCellComponentProps) => {
  const { config } = useConfig()

  if (rowData?.status !== 'completed') {
    return <span>—</span>
  }

  return (
    <a
      download
      href={formatAdminURL({
        apiRoute: config.routes.api,
        path: `/${collectionSlug}/${String(rowData.id)}/download`,
      })}
      // Keep the click from opening the document, which the row link would do.
      onClick={(event) => event.stopPropagation()}
    >
      Export
    </a>
  )
}
