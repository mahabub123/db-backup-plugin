import type { Payload } from 'payload'

/**
 * Runs one of the `afterBackup`, `afterBackupFailed` or `afterRestore`
 * callbacks. A failing callback (e.g. an email that can't be sent) is logged
 * and never changes the outcome of the backup or restore.
 */
export const notify = async (
  payload: Payload,
  name: string,
  callback: () => Promise<void> | undefined | void,
): Promise<void> => {
  try {
    await callback()
  } catch (error) {
    payload.logger.error({ err: error, msg: `[payload-plugin-backup] The ${name} callback failed` })
  }
}
