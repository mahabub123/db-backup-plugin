import type { Payload, Where } from 'payload'

import type { BackupFrequency, SanitizedBackupPluginConfig } from '../types.js'
import type { BackupRecord } from './createBackup.js'

import { createBackup } from './createBackup.js'

export const FREQUENCIES: BackupFrequency[] = ['daily', 'weekly', 'monthly']

export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

export type Weekday = (typeof WEEKDAYS)[number]

/** The values of the Backup Settings global. */
export type ScheduleSettings = {
  daily?: { enabled?: boolean | null; keep?: null | number } | null
  enabled?: boolean | null
  includeMedia?: boolean | null
  monthly?: { day?: null | number; enabled?: boolean | null; keep?: null | number } | null
  /** 24h clock, e.g. "03:00", in `timezone`. */
  time?: null | string
  timezone?: null | string
  weekly?: { day?: null | Weekday; enabled?: boolean | null; keep?: null | number } | null
}

const DAY = 24 * 60 * 60 * 1000
/** Don't hammer a failing database or bucket: wait this long before retrying. */
const RETRY_AFTER = 60 * 60 * 1000
/** A backup still "running" after this long is assumed to have crashed. */
const STALE_RUNNING = 6 * 60 * 60 * 1000

export const parseTime = (time?: null | string): { hour: number; minute: number } => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((time ?? '').trim())
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 3, minute: 0 }
}

export const isValidTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** Calendar date and time of an instant, as seen in `timezone`. */
const getZonedParts = (instant: number, timezone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
      minute: 'numeric',
      month: 'numeric',
      second: 'numeric',
      timeZone: timezone,
      year: 'numeric',
    })
      .formatToParts(new Date(instant))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<'day' | 'hour' | 'minute' | 'month' | 'second' | 'year', number>
  return parts
}

/** Milliseconds `timezone` is ahead of UTC at `instant`. */
const getOffset = (instant: number, timezone: string): number => {
  const p = getZonedParts(instant, timezone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (instant - (instant % 1000))
}

/** The instant at which the wall clock in `timezone` shows the given date and time. */
export const zonedTimeToInstant = (
  { day, hour, minute, month, year }: { day: number; hour: number; minute: number; month: number; year: number },
  timezone: string,
): number => {
  const wallClock = Date.UTC(year, month - 1, day, hour, minute)
  const first = wallClock - getOffset(wallClock, timezone)
  // Re-check at the result in case a DST change sits between the two.
  return wallClock - getOffset(first, timezone)
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** Whether a backup of this frequency is planned on the given calendar date. */
const isScheduledDate = (
  frequency: BackupFrequency,
  settings: ScheduleSettings,
  { day, month, year }: { day: number; month: number; year: number },
): boolean => {
  if (frequency === 'daily') {
    return true
  }
  if (frequency === 'weekly') {
    const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
    return weekday === (settings.weekly?.day ?? 'sunday')
  }
  // In shorter months a day like the 31st falls back to the last day of the month.
  const wanted = Math.min(Math.max(settings.monthly?.day ?? 1, 1), daysInMonth(year, month))
  return day === wanted
}

/**
 * Walks the calendar from `now` (in the configured timezone) and returns the
 * first planned run in the given direction.
 */
const findSlot = (
  frequency: BackupFrequency,
  settings: ScheduleSettings,
  now: Date,
  direction: 'next' | 'previous',
): Date => {
  const timezone = settings.timezone && isValidTimezone(settings.timezone) ? settings.timezone : 'UTC'
  const { hour, minute } = parseTime(settings.time)
  const today = getZonedParts(now.getTime(), timezone)
  const step = direction === 'previous' ? -1 : 1

  for (let offset = 0; offset <= 62; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day) + step * offset * DAY)
    const calendarDay = {
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      year: date.getUTCFullYear(),
    }
    if (!isScheduledDate(frequency, settings, calendarDay)) {
      continue
    }
    const instant = zonedTimeToInstant({ ...calendarDay, hour, minute }, timezone)
    if (direction === 'previous' ? instant <= now.getTime() : instant > now.getTime()) {
      return new Date(instant)
    }
  }
  throw new Error(`Could not compute the ${direction} ${frequency} backup time.`)
}

/** The most recent moment a backup of this frequency was planned for. */
export const getPreviousRun = (frequency: BackupFrequency, settings: ScheduleSettings, now: Date) =>
  findSlot(frequency, settings, now, 'previous')

/** The next moment a backup of this frequency is planned for. */
export const getNextRun = (frequency: BackupFrequency, settings: ScheduleSettings, now: Date) =>
  findSlot(frequency, settings, now, 'next')

export const getEnabledFrequencies = (settings: ScheduleSettings): BackupFrequency[] =>
  settings.enabled ? FREQUENCIES.filter((frequency) => settings[frequency]?.enabled) : []

const findLatest = async (
  payload: Payload,
  options: SanitizedBackupPluginConfig,
  where: Where,
): Promise<BackupRecord | undefined> => {
  const { docs } = await payload.find({
    collection: options.slug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    sort: '-startedAt',
    where,
  })
  return docs[0] as BackupRecord | undefined
}

/**
 * Which frequencies need a backup right now: their last planned time has
 * passed and no completed scheduled backup covers it yet.
 */
export const getDueFrequencies = async ({
  now,
  options,
  payload,
  settings,
}: {
  now: Date
  options: SanitizedBackupPluginConfig
  payload: Payload
  settings: ScheduleSettings
}): Promise<BackupFrequency[]> => {
  const due: BackupFrequency[] = []

  for (const frequency of getEnabledFrequencies(settings)) {
    const plannedAt = getPreviousRun(frequency, settings, now)
    const latest = await findLatest(payload, options, {
      and: [
        { frequencies: { in: [frequency] } },
        { status: { equals: 'completed' } },
      ],
    })
    if (latest && new Date(latest.startedAt as string) >= plannedAt) {
      continue
    }

    const lastFailure = await findLatest(payload, options, {
      and: [
        { frequencies: { in: [frequency] } },
        { status: { equals: 'failed' } },
      ],
    })
    if (lastFailure && now.getTime() - new Date(lastFailure.startedAt as string).getTime() < RETRY_AFTER) {
      continue
    }

    due.push(frequency)
  }

  return due
}

/**
 * Keeps the newest `keep` backups of each frequency and deletes scheduled
 * backups no frequency wants anymore. A backup taken for several frequencies
 * at once (e.g. a Sunday that is also the 1st) stays while any of them keeps it.
 */
export const applyScheduleRetention = async ({
  options,
  payload,
  settings,
}: {
  options: SanitizedBackupPluginConfig
  payload: Payload
  settings: ScheduleSettings
}): Promise<number> => {
  const { docs } = await payload.find({
    collection: options.slug,
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    sort: '-startedAt',
    where: { and: [{ type: { equals: 'scheduled' } }, { status: { equals: 'completed' } }] },
  })

  const keep = new Set<number | string>()
  for (const frequency of FREQUENCIES) {
    const limit = Math.max(settings[frequency]?.keep ?? 0, 0)
    docs
      .filter((doc) => ((doc.frequencies as string[] | undefined) ?? []).includes(frequency))
      .slice(0, limit)
      .forEach((doc) => keep.add(doc.id))
  }

  const expired = docs.filter((doc) => !keep.has(doc.id))
  for (const doc of expired) {
    await payload.delete({ id: doc.id, collection: options.slug, overrideAccess: true })
  }
  return expired.length
}

export type ScheduledRunResult = {
  backup?: BackupRecord
  deleted: number
  frequencies: BackupFrequency[]
  reason?: string
}

/**
 * Called every few minutes (by the in-process timer or the cron endpoint).
 * Takes at most one backup per call, tagged with every frequency that is due.
 */
export const runScheduledBackups = async ({
  now = new Date(),
  options,
  payload,
}: {
  now?: Date
  options: SanitizedBackupPluginConfig
  payload: Payload
}): Promise<ScheduledRunResult> => {
  const settings = (await payload.findGlobal({
    slug: options.settingsSlug,
    depth: 0,
    overrideAccess: true,
  })) as ScheduleSettings

  if (!settings.enabled) {
    return { deleted: 0, frequencies: [], reason: 'Automatic backups are turned off.' }
  }

  const running = await findLatest(payload, options, { status: { equals: 'running' } })
  if (running) {
    if (now.getTime() - new Date(running.startedAt as string).getTime() < STALE_RUNNING) {
      return { deleted: 0, frequencies: [], reason: 'Another backup is running.' }
    }
    // The server was stopped or crashed in the middle of that backup.
    await payload.update({
      id: running.id,
      collection: options.slug,
      data: { error: 'Interrupted before it could finish.', status: 'failed' },
      overrideAccess: true,
    })
  }

  const frequencies = await getDueFrequencies({ now, options, payload, settings })
  if (!frequencies.length) {
    return { deleted: 0, frequencies, reason: 'No backup is due.' }
  }

  payload.logger.info(`[payload-plugin-backup] Starting scheduled ${frequencies.join(' + ')} backup.`)
  const backup = await createBackup({
    type: 'scheduled',
    frequencies,
    includeMedia: settings.includeMedia ?? true,
    now,
    options,
    payload,
  })
  const deleted = await applyScheduleRetention({ options, payload, settings })

  return { backup, deleted, frequencies }
}
