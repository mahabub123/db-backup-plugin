import type { Payload } from 'payload'

import path from 'path'

import type { SanitizedBackupPluginConfig } from '../types.js'

import { runScheduledBackups } from './schedule.js'

/** Survives Next.js hot reloads, which re-run onInit in the same process. */
const TIMER_KEY = Symbol.for('payload-plugin-backup.scheduler')
type TimerState = { interval?: NodeJS.Timeout; running: boolean; timeout?: NodeJS.Timeout }
const globalState = globalThis as unknown as Record<symbol, TimerState | undefined>

/** One-off `payload` CLI commands (migrate, backup:export, ...) must not start backups. */
const isPayloadCLI = () =>
  process.argv.some((arg) => arg.endsWith(`${path.sep}payload${path.sep}bin.js`) || /[\\/]\.bin[\\/]payload$/.test(arg))

export const stopScheduler = () => {
  const state = globalState[TIMER_KEY]
  if (state) {
    clearTimeout(state.timeout)
    clearInterval(state.interval)
  }
  globalState[TIMER_KEY] = undefined
}

/**
 * Checks every few minutes whether a daily/weekly/monthly backup is due.
 * The timers don't keep the process alive, and overlapping checks are skipped.
 */
export const startScheduler = (payload: Payload, options: SanitizedBackupPluginConfig) => {
  stopScheduler()
  if (!options.schedule.enabled || !options.schedule.runOnServer || isPayloadCLI()) {
    return
  }

  const state: TimerState = { running: false }
  globalState[TIMER_KEY] = state

  const check = async () => {
    if (state.running) {
      return
    }
    state.running = true
    try {
      await runScheduledBackups({ options, payload })
    } catch (error) {
      payload.logger.error({ err: error, msg: '[payload-plugin-backup] Scheduled backup failed' })
    } finally {
      state.running = false
    }
  }

  // Give the server a minute to finish starting before the first check.
  state.timeout = setTimeout(() => void check(), 60_000)
  state.interval = setInterval(() => void check(), options.schedule.intervalMinutes * 60_000)
  state.timeout.unref()
  state.interval.unref()
}
