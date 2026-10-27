import { getNextRun, getPreviousRun, type ScheduleSettings } from '../src/core/schedule.js'
import { describe, expect, test } from 'vitest'

const settings = (overrides: ScheduleSettings = {}): ScheduleSettings => ({
  daily: { enabled: true, keep: 7 },
  enabled: true,
  monthly: { day: 1, enabled: true, keep: 12 },
  time: '03:00',
  timezone: 'UTC',
  weekly: { day: 'sunday', enabled: true, keep: 4 },
  ...overrides,
})

const iso = (date: Date) => date.toISOString()

describe('schedule times', () => {
  test('daily: today if the time has passed, otherwise yesterday', () => {
    expect(iso(getPreviousRun('daily', settings(), new Date('2026-10-27T05:00:00Z')))).toBe(
      '2026-10-27T03:00:00.000Z',
    )
    expect(iso(getPreviousRun('daily', settings(), new Date('2026-10-27T02:59:00Z')))).toBe(
      '2026-10-26T03:00:00.000Z',
    )
    expect(iso(getNextRun('daily', settings(), new Date('2026-10-27T03:00:00Z')))).toBe(
      '2026-10-28T03:00:00.000Z',
    )
  })

  test('weekly: the chosen weekday', () => {
    // 2026-10-27 is a Tuesday.
    const now = new Date('2026-10-27T12:00:00Z')
    expect(iso(getPreviousRun('weekly', settings(), now))).toBe('2026-10-25T03:00:00.000Z')
    expect(iso(getNextRun('weekly', settings(), now))).toBe('2026-11-01T03:00:00.000Z')
    const friday = settings({ weekly: { day: 'friday', enabled: true, keep: 4 } })
    expect(iso(getNextRun('weekly', friday, now))).toBe('2026-10-30T03:00:00.000Z')
  })

  test('monthly: the 31st falls back to the last day of shorter months', () => {
    const last = settings({ monthly: { day: 31, enabled: true, keep: 12 } })
    expect(iso(getNextRun('monthly', last, new Date('2027-02-10T00:00:00Z')))).toBe(
      '2027-02-28T03:00:00.000Z',
    )
    expect(iso(getPreviousRun('monthly', last, new Date('2027-03-10T00:00:00Z')))).toBe(
      '2027-02-28T03:00:00.000Z',
    )
  })

  test('uses the configured time zone', () => {
    // 03:00 in Dhaka (UTC+6) is 21:00 UTC the day before.
    const dhaka = settings({ timezone: 'Asia/Dhaka' })
    expect(iso(getNextRun('daily', dhaka, new Date('2026-10-27T12:00:00Z')))).toBe(
      '2026-10-27T21:00:00.000Z',
    )
  })

  test('handles daylight saving changes', () => {
    // London leaves summer time on 2026-10-25: 03:00 is 02:00 UTC before, 03:00 UTC after.
    const london = settings({ timezone: 'Europe/London' })
    expect(iso(getPreviousRun('daily', london, new Date('2026-10-24T12:00:00Z')))).toBe(
      '2026-10-24T02:00:00.000Z',
    )
    expect(iso(getPreviousRun('daily', london, new Date('2026-10-26T12:00:00Z')))).toBe(
      '2026-10-26T03:00:00.000Z',
    )
  })

  test('falls back to sensible values for bad input', () => {
    const bad = settings({ time: 'noon', timezone: 'Mars/Olympus' })
    expect(iso(getNextRun('daily', bad, new Date('2026-10-27T12:00:00Z')))).toBe(
      '2026-10-28T03:00:00.000Z',
    )
  })
})
