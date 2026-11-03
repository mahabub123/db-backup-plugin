import type { SanitizedConfig } from 'payload'

import { verifyBackup } from '../core/verify.js'
import { parseCommandArgs, runCommand } from './shared.js'

const usage = `Usage: payload backup:verify <backup id>

  Downloads a backup and checks that it is complete, unchanged and can be
  restored on this site, without changing anything. Exits with status 1 when
  the backup has problems.`

/**
 * `payload backup:verify` — check a stored backup.
 * Registered by the plugin through Payload's `bin` config.
 */
export const script = async (config: SanitizedConfig) => {
  const { positionals, values } = parseCommandArgs({
    help: { type: 'boolean', short: 'h' },
  })
  if (values.help || !positionals[0]) {
    console.log(usage)
    process.exit(values.help ? 0 : 1)
  }

  await runCommand(config, async ({ options, payload }) => {
    console.log(`Verifying backup ${positionals[0]}…`)
    const result = await verifyBackup({ id: positionals[0], options, payload })
    for (const warning of result.warnings) {
      console.warn(`⚠ ${warning}`)
    }
    if (!result.ok) {
      throw new Error(`The backup has problems:\n  ${result.errors.join('\n  ')}`)
    }
    console.log(`✔ ${result.documents} documents checked; the backup can be restored.`)
  })
}
