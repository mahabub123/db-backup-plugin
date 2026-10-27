import type { SanitizedConfig } from 'payload'

import { syncFromStorage } from '../core/importBackup.js'
import { parseCommandArgs, runCommand } from './shared.js'

const usage = `Usage: payload backup:sync

  Adds every backup found in the configured storage (S3, R2, local folder)
  that is missing from the backups list, e.g. after moving to a new database.`

/** `payload backup:sync` — find backups in storage after losing the database. */
export const script = async (config: SanitizedConfig) => {
  const { values } = parseCommandArgs({ help: { type: 'boolean', short: 'h' } })
  if (values.help) {
    console.log(usage)
    process.exit(0)
  }

  await runCommand(config, async ({ options, payload }) => {
    console.log(`Looking for backups in ${options.storage.name} storage…`)
    const { added, skipped } = await syncFromStorage({ options, payload })
    for (const backup of added) {
      console.log(`✔ Added backup ${String(backup.id)} (${backup.filename})`)
    }
    for (const { filename, reason } of skipped) {
      console.warn(`⚠ Skipped ${filename}: ${reason}`)
    }
    console.log(`Done: ${added.length} added, ${skipped.length} skipped.`)
  })
}
