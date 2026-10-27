import type { Field, GlobalConfig } from 'payload'

import type { SanitizedBackupPluginConfig } from '../types.js'

import { isValidTimezone, type ScheduleSettings, WEEKDAYS } from '../core/schedule.js'

const keepField = (defaultValue: number, unit: string): Field => ({
  name: 'keep',
  type: 'number',
  admin: {
    description: `Older ${unit} backups are deleted automatically, from the list and from storage.`,
    width: '50%',
  },
  defaultValue,
  label: `Keep the last`,
  min: 1,
  required: true,
})

const enabledField = (label: string, defaultValue: boolean): Field => ({
  name: 'enabled',
  type: 'checkbox',
  defaultValue,
  label,
})

export const createBackupSettingsGlobal = ({
  adminGroup,
  disabled,
  options,
}: {
  adminGroup: string
  disabled: boolean
  options: SanitizedBackupPluginConfig
}): GlobalConfig => {
  const { defaults } = options.schedule
  const showWhen =
    (frequency: 'daily' | 'monthly' | 'weekly') => (data: ScheduleSettings) =>
      Boolean(data?.enabled && data?.[frequency]?.enabled)

  return {
    slug: options.settingsSlug,
    access: {
      read: options.access,
      update: options.access,
    },
    admin: {
      description:
        'Take backups automatically. Each backup contains the whole database and, optionally, every uploaded file.',
      group: adminGroup,
    },
    fields: [
      {
        name: 'status',
        type: 'ui',
        admin: {
          components: { Field: 'payload-plugin-backup/rsc#BackupScheduleStatus' },
          condition: () => !disabled && options.schedule.enabled,
        },
      },
      {
        name: 'enabled',
        type: 'checkbox',
        defaultValue: defaults.enabled,
        label: 'Automatic backups',
      },
      {
        type: 'row',
        admin: { condition: (data) => Boolean(data?.enabled) },
        fields: [
          {
            name: 'time',
            type: 'text',
            admin: { description: '24-hour clock, e.g. 03:00.', width: '33%' },
            defaultValue: defaults.time,
            label: 'Time of day',
            required: true,
            validate: (value: null | string | undefined) =>
              /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value ?? '') || 'Use HH:MM, e.g. 03:00.',
          },
          {
            name: 'timezone',
            type: 'text',
            admin: { description: 'e.g. UTC, Europe/London, Asia/Dhaka.', width: '33%' },
            defaultValue: defaults.timezone,
            required: true,
            validate: (value: null | string | undefined) =>
              (value ? isValidTimezone(value) : false) || 'Unknown time zone.',
          },
          {
            name: 'includeMedia',
            type: 'checkbox',
            admin: { style: { alignSelf: 'center' }, width: '33%' },
            defaultValue: defaults.includeMedia,
            label: 'Include uploaded files',
          },
        ],
      },
      {
        name: 'daily',
        type: 'group',
        admin: {
          condition: (data) => Boolean(data?.enabled),
          description: 'A backup every day.',
        },
        fields: [
          enabledField('Daily backups', defaults.daily.enabled),
          {
            type: 'row',
            admin: { condition: showWhen('daily') },
            fields: [keepField(defaults.daily.keep, 'daily')],
          },
        ],
        label: 'Daily',
      },
      {
        name: 'weekly',
        type: 'group',
        admin: {
          condition: (data) => Boolean(data?.enabled),
          description: 'A backup once a week.',
        },
        fields: [
          enabledField('Weekly backups', defaults.weekly.enabled),
          {
            type: 'row',
            admin: { condition: showWhen('weekly') },
            fields: [
              {
                name: 'day',
                type: 'select',
                admin: { width: '50%' },
                defaultValue: defaults.weekly.day,
                label: 'Day of the week',
                options: WEEKDAYS.map((day) => ({
                  label: day[0].toUpperCase() + day.slice(1),
                  value: day,
                })),
                required: true,
              },
              keepField(defaults.weekly.keep, 'weekly'),
            ],
          },
        ],
        label: 'Weekly',
      },
      {
        name: 'monthly',
        type: 'group',
        admin: {
          condition: (data) => Boolean(data?.enabled),
          description: 'A backup once a month.',
        },
        fields: [
          enabledField('Monthly backups', defaults.monthly.enabled),
          {
            type: 'row',
            admin: { condition: showWhen('monthly') },
            fields: [
              {
                name: 'day',
                type: 'number',
                admin: {
                  description: 'In shorter months, the last day of the month is used.',
                  width: '50%',
                },
                defaultValue: defaults.monthly.day,
                label: 'Day of the month',
                max: 31,
                min: 1,
                required: true,
              },
              keepField(defaults.monthly.keep, 'monthly'),
            ],
          },
        ],
        label: 'Monthly',
      },
    ],
    label: 'Backup Settings',
  }
}
