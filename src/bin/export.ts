import type { SanitizedConfig } from 'payload'

import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'

import type { BackupRecord } from '../core/createBackup.js'

import { createBackup } from '../core/createBackup.js'
import { assertSameStorage } from '../core/storageCheck.js'
import { formatSize, parseCommandArgs, runCommand } from './shared.js'

const usage = `Usage: payload backup:export [output.tar.gz] [--id <backup id>] [--no-media]

  Creates a new backup and saves it to a file. With --id, exports an existing
  backup instead. The output defaults to the backup's file name in the
  current directory.`

/**
 * `payload backup:export` — save a backup of the site to a local file.
 * Registered by the plugin through Payload's `bin` config.
 */
export const script = async (config: SanitizedConfig) => {
  const { positionals, values } = parseCommandArgs({
    id: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    'no-media': { type: 'boolean' },
  })
  if (values.help) {
    console.log(usage)
    process.exit(0)
  }

  await runCommand(config, async ({ options, payload }) => {
    let backup: BackupRecord
    if (values.id) {
      backup = (await payload.findByID({
        id: values.id,
        collection: options.slug,
        depth: 0,
        overrideAccess: true,
      })) as unknown as BackupRecord
      if (backup.status !== 'completed') {
        throw new Error(`Backup ${values.id} is not complete.`)
      }
    } else {
      console.log('Creating backup…')
      backup = await createBackup({
        type: 'manual',
        includeMedia: !values['no-media'],
        options,
        payload,
      })
    }

    assertSameStorage(backup, options)
    const output = path.resolve(positionals[0] ?? backup.filename)
    await fs.promises.mkdir(path.dirname(output), { recursive: true })
    await pipeline(
      await options.storage.download({ filename: backup.filename }),
      fs.createWriteStream(output),
    )
    const { size } = await fs.promises.stat(output)
    console.log(`✔ Exported backup ${String(backup.id)} to ${output} (${formatSize(size)})`)
  })
}
