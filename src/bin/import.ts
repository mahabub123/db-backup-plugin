import type { SanitizedConfig } from 'payload'

import fs from 'fs'
import path from 'path'

import { importBackup } from '../core/importBackup.js'
import { restoreBackup } from '../core/restoreBackup.js'
import { confirm, formatSize, parseCommandArgs, runCommand } from './shared.js'

const usage = `Usage: payload backup:import <file.tar.gz> [--restore] [--yes]

  Adds a backup file to the backups list. With --restore, also restores it,
  replacing all content of this site (asks for confirmation unless --yes).`

/**
 * `payload backup:import` — add a backup file to the site, and optionally restore it.
 * Registered by the plugin through Payload's `bin` config.
 */
export const script = async (config: SanitizedConfig) => {
  const { positionals, values } = parseCommandArgs({
    help: { type: 'boolean', short: 'h' },
    restore: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  })
  if (values.help || !positionals[0]) {
    console.log(usage)
    process.exit(values.help ? 0 : 1)
  }

  const file = path.resolve(positionals[0])

  await runCommand(config, async ({ options, payload }) => {
    const { size } = await fs.promises.stat(file)
    console.log(`Importing ${file} (${formatSize(size)})…`)

    const { backup, warnings } = await importBackup({
      options,
      originalFilename: path.basename(file),
      payload,
      stream: fs.createReadStream(file),
    })
    for (const warning of warnings) {
      console.warn(`⚠ ${warning}`)
    }
    console.log(`✔ Imported as backup ${String(backup.id)} (${backup.filename})`)

    if (!values.restore) {
      console.log('Restore it from the admin panel, or run this again with --restore.')
      return
    }

    if (
      !values.yes &&
      !(await confirm(
        'This replaces ALL content of this site, including users and files. Type RESTORE to continue: ',
        'RESTORE',
      ))
    ) {
      throw new Error('Restore cancelled. (Use --yes to skip the prompt in scripts.)')
    }

    const { safetyBackup, summary } = await restoreBackup({ id: backup.id, options, payload })
    const documents = summary.collections.reduce((sum, { count }) => sum + count, 0)
    console.log(
      `✔ Restored ${documents} documents and ${summary.files.restored} files.` +
        (safetyBackup ? ` The previous state was saved as backup ${String(safetyBackup.id)}.` : ''),
    )
  })
}
