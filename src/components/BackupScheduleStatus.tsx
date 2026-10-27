import type { Payload } from 'payload'

import type { BackupFrequency } from '../types.js'

import {
  FREQUENCIES,
  getEnabledFrequencies,
  getNextRun,
  type ScheduleSettings,
} from '../core/schedule.js'
import { getOptions } from '../utilities/getOptions.js'

const boxStyle: React.CSSProperties = {
  border: '1px solid var(--theme-elevation-150)',
  borderRadius: 'var(--style-radius-m)',
  display: 'grid',
  gap: 'calc(var(--base) * 0.5)',
  marginBottom: 'var(--base)',
  padding: 'calc(var(--base) * 0.75) var(--base)',
}

const LABELS: Record<BackupFrequency, string> = {
  daily: 'Daily',
  monthly: 'Monthly',
  weekly: 'Weekly',
}

const formatDate = (date: Date | string | undefined, timezone: string) =>
  date
    ? new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(new Date(date))
    : '—'

/** Where scheduled backups go and when the next ones run. Saved values only. */
export const BackupScheduleStatus = async ({ payload }: { payload: Payload }) => {
  const options = getOptions(payload)
  const settings = (await payload.findGlobal({
    slug: options.settingsSlug,
    depth: 0,
    overrideAccess: true,
  })) as ScheduleSettings
  const timezone = settings.timezone || 'UTC'
  const enabled = getEnabledFrequencies(settings)
  const now = new Date()

  const rows = await Promise.all(
    FREQUENCIES.map(async (frequency) => {
      const { docs } = await payload.find({
        collection: options.slug,
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        sort: '-startedAt',
        where: {
          and: [
            { frequencies: { in: [frequency] } },
            { status: { in: ['completed', 'failed'] } },
          ],
        },
      })
      const last = docs[0] as { startedAt?: string; status?: string } | undefined
      return {
        frequency,
        last,
        next: enabled.includes(frequency) ? getNextRun(frequency, settings, now) : undefined,
      }
    }),
  )

  const trigger = options.schedule.runOnServer
    ? `This server checks every ${options.schedule.intervalMinutes} minutes whether a backup is due.`
    : options.schedule.cronSecret
      ? `Backups run when your external cron calls /api/${options.slug}/cron.`
      : `Nothing triggers backups yet: enable runOnServer or set a cronSecret for an external cron.`

  return (
    <div style={boxStyle}>
      <div>
        <strong>Storage:</strong> {options.storage.name} · {trigger}
      </div>
      {!settings.enabled ? (
        <div>Automatic backups are off. Turn them on below and save.</div>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th>Schedule</th>
              <th>Last backup</th>
              <th>Next backup ({timezone})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ frequency, last, next }) => (
              <tr key={frequency}>
                <td>{LABELS[frequency]}</td>
                <td>
                  {formatDate(last?.startedAt, timezone)}
                  {last?.status === 'failed' ? ' (failed)' : ''}
                </td>
                <td>{next ? formatDate(next, timezone) : 'Off'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
