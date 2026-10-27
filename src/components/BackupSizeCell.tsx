'use client'
import type { DefaultCellComponentProps } from 'payload'

import { formatBytes } from './shared.js'

export const BackupSizeCell = ({ cellData }: DefaultCellComponentProps) => (
  <span>{formatBytes(cellData)}</span>
)
