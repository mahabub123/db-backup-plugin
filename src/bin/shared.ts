import type { Payload, SanitizedConfig } from 'payload'

import { getPayload } from 'payload'
import readline from 'readline/promises'
import { parseArgs, type ParseArgsConfig } from 'util'

import type { SanitizedBackupPluginConfig } from '../types.js'

import { getOptions } from '../utilities/getOptions.js'

/** Arguments after the command name, e.g. `payload backup:export ./site.tar.gz --no-media`. */
export const parseCommandArgs = <T extends ParseArgsConfig['options']>(options: T) => {
  const commandIndex = process.argv.findIndex((arg) => arg.startsWith('backup:'))
  return parseArgs({
    allowPositionals: true,
    args: process.argv.slice(commandIndex + 1),
    options,
    strict: true,
  })
}

export const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export const confirm = async (question: string, expected: string): Promise<boolean> => {
  if (!process.stdin.isTTY) {
    return false
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim() === expected
  } finally {
    rl.close()
  }
}

/** Boots Payload, runs the command, and exits with a proper status code. */
export const runCommand = async (
  config: SanitizedConfig,
  command: (args: { options: SanitizedBackupPluginConfig; payload: Payload }) => Promise<void>,
): Promise<never> => {
  let payload: Payload | undefined
  let exitCode = 0
  try {
    payload = await getPayload({ config })
    await command({ options: getOptions(payload), payload })
  } catch (error) {
    console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}`)
    exitCode = 1
  } finally {
    await payload?.destroy().catch(() => undefined)
  }
  process.exit(exitCode)
}
