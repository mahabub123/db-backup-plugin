import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'

let cached: { payloadVersion: string; pluginVersion: string } | undefined

const readVersion = (file: string): string => {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Versions written to every manifest so an archive can be traced back to its origin. */
export const getPackageVersions = () => {
  if (!cached) {
    const dirname = path.dirname(fileURLToPath(import.meta.url))
    let payloadVersion = 'unknown'
    try {
      const payloadEntry = createRequire(import.meta.url).resolve('payload')
      const payloadRoot = payloadEntry.slice(0, payloadEntry.lastIndexOf(`${path.sep}dist${path.sep}`))
      payloadVersion = readVersion(path.join(payloadRoot, 'package.json'))
    } catch {
      // payload could not be resolved from here; the version is informational only
    }
    cached = {
      payloadVersion,
      // src/utilities or dist/utilities -> package root
      pluginVersion: readVersion(path.join(dirname, '..', '..', 'package.json')),
    }
  }
  return cached
}
