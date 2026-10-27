'use client'

export const formatBytes = (bytes: unknown): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    return '—'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Reads `{ errors: [{ message }] }` from a failed Payload response. */
export const readError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { errors?: { message?: string }[]; message?: string }
    return body.errors?.[0]?.message ?? body.message ?? response.statusText
  } catch {
    return response.statusText || `Request failed (${response.status})`
  }
}
