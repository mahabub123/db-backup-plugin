import type { Payload, Where } from 'payload'

import type { BackupFrequency, BackupRecord, SanitizedBackupPluginConfig } from '../types.js'

import { getActiveTask, type Task } from './lock.js'
import { getEnabledFrequencies, getPreviousRun, type ScheduleSettings } from './schedule.js'

export type BackupHealth = {
  /** The backup or restore running right now on any server. */
  activeTask?: Task
  lastCompleted?: { filename: string; id: number | string; startedAt: string; verified?: boolean | null }
  ok: boolean
  /** Why the backups need attention; empty when everything is fine. */
  problems: string[]
  schedules: {
    frequency: BackupFrequency
    lastCompletedAt?: string
    overdue: boolean
    plannedAt: string
  }[]
  status: 'failing' | 'not-scheduled' | 'ok'
}

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
  return docs[0] as unknown as BackupRecord | undefined
}

/**
 * Whether the site is protected: every enabled schedule has a completed
 * backup for its last planned time (allowing `healthGraceMinutes`), the last
 * scheduled backup didn't fail, and the newest backup passed verification if
 * it was verified.
 */
export const getBackupHealth = async ({
  now = new Date(),
  options,
  payload,
}: {
  now?: Date
  options: SanitizedBackupPluginConfig
  payload: Payload
}): Promise<BackupHealth> => {
  const settings = (await payload.findGlobal({
    slug: options.settingsSlug,
    depth: 0,
    overrideAccess: true,
  })) as { updatedAt?: string } & ScheduleSettings
  const grace = options.healthGraceMinutes * 60_000
  const problems: string[] = []
  const activeTask = await getActiveTask(payload, options)

  const newest = await findLatest(payload, options, { status: { equals: 'completed' } })
  const lastCompleted = newest
    ? {
        id: newest.id,
        filename: newest.filename,
        startedAt: String(newest.startedAt),
        verified: newest.verified as boolean | null | undefined,
      }
    : undefined
  if (newest && newest.verified === false) {
    problems.push(`The newest backup ${newest.filename} failed verification.`)
  }

  if (!options.schedule.enabled || !settings.enabled) {
    return {
      activeTask,
      lastCompleted,
      ok: problems.length === 0,
      problems,
      schedules: [],
      status: problems.length ? 'failing' : 'not-scheduled',
    }
  }

  // Slots planned before the schedule was last changed don't count.
  const changedAt = settings.updatedAt ? new Date(settings.updatedAt).getTime() : 0
  const schedules: BackupHealth['schedules'] = []

  for (const frequency of getEnabledFrequencies(settings)) {
    const plannedAt = getPreviousRun(frequency, settings, now)
    // Until the grace period of the latest slot is over, the slot before it must be covered.
    const requiredSlot =
      now.getTime() > plannedAt.getTime() + grace
        ? plannedAt
        : getPreviousRun(frequency, settings, new Date(plannedAt.getTime() - 1))
    const latest = await findLatest(payload, options, {
      and: [{ frequencies: { in: [frequency] } }, { status: { equals: 'completed' } }],
    })
    const lastCompletedAt = latest ? String(latest.startedAt) : undefined
    const overdue =
      requiredSlot.getTime() >= changedAt &&
      (!lastCompletedAt || new Date(lastCompletedAt).getTime() < requiredSlot.getTime())
    if (overdue) {
      problems.push(
        `The ${frequency} backup planned for ${requiredSlot.toISOString()} has not completed${lastCompletedAt ? ` (last one: ${lastCompletedAt})` : ''}.`,
      )
    }
    schedules.push({ frequency, lastCompletedAt, overdue, plannedAt: plannedAt.toISOString() })
  }

  const lastScheduled = await findLatest(payload, options, {
    and: [{ type: { equals: 'scheduled' } }, { status: { in: ['completed', 'failed'] } }],
  })
  if (lastScheduled?.status === 'failed') {
    problems.push(
      `The last scheduled backup failed: ${typeof lastScheduled.error === 'string' ? lastScheduled.error : 'unknown error'}`,
    )
  }

  return {
    activeTask,
    lastCompleted,
    ok: problems.length === 0,
    problems,
    schedules,
    status: problems.length ? 'failing' : 'ok',
  }
}
