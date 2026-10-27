import type { PayloadRequest, SanitizedCollectionConfig } from 'payload'
import type { ReadableStream as WebReadableStream } from 'stream/web'

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export type MediaFile = {
  filename: string
  prefix?: string
}

/** The original file plus every generated image size of an upload document. */
export const getDocumentFiles = (doc: Record<string, unknown>): MediaFile[] => {
  const prefix = typeof doc.prefix === 'string' && doc.prefix ? doc.prefix : undefined
  const files: MediaFile[] = []

  if (typeof doc.filename === 'string' && doc.filename) {
    files.push({ filename: doc.filename, prefix })
  }

  if (doc.sizes && typeof doc.sizes === 'object') {
    for (const size of Object.values(doc.sizes as Record<string, unknown>)) {
      const filename = (size as { filename?: unknown } | null)?.filename
      if (typeof filename === 'string' && filename) {
        files.push({ filename, prefix })
      }
    }
  }

  return files
}

/** Resolves `segments` inside `root`, refusing anything that would land outside of it. */
export const resolveInside = (root: string, ...segments: string[]): string => {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...segments)
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to access a path outside of ${resolvedRoot}: ${segments.join('/')}`)
  }
  return target
}

export const getArchiveMediaPath = (
  archiveDir: string,
  collection: string,
  { filename, prefix }: MediaFile,
): string => resolveInside(archiveDir, 'media', collection, ...(prefix ? [prefix] : []), filename)

const getStaticDir = (collection: SanitizedCollectionConfig): string =>
  path.resolve(collection.upload.staticDir || collection.slug)

type UploadHandler = (
  req: PayloadRequest,
  args: {
    doc?: Record<string, unknown>
    headers?: Headers
    params: { collection: string; filename: string; prefix?: string }
  },
) => Promise<Response | void> | Response | void

/**
 * Copies one file of an upload document into the archive folder.
 * Local files are copied from the collection's `staticDir`; files handled by a
 * storage adapter (S3, R2, Azure, GCS, Vercel Blob, ...) are streamed through
 * the adapter's static handler, the same way Payload serves them.
 *
 * @returns false when the file could not be found
 */
export const copyFileToArchive = async ({
  collection,
  destination,
  doc,
  file,
  req,
}: {
  collection: SanitizedCollectionConfig
  destination: string
  doc: Record<string, unknown>
  file: MediaFile
  req: PayloadRequest
}): Promise<boolean> => {
  await fsp.mkdir(path.dirname(destination), { recursive: true })

  if (!collection.upload.disableLocalStorage) {
    try {
      await fsp.copyFile(resolveInside(getStaticDir(collection), file.filename), destination)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  const handlers = (collection.upload.handlers ?? []) as unknown as UploadHandler[]

  for (const handler of handlers) {
    const response = await handler(req, {
      doc,
      headers: new Headers(),
      params: { collection: collection.slug, filename: file.filename, prefix: file.prefix },
    })

    if (response instanceof Response) {
      if (!response.ok || !response.body) {
        return false
      }
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream),
        fs.createWriteStream(destination),
      )
      return true
    }
  }

  return false
}

/** Writes a file from the extracted archive back into a local upload collection. */
export const copyFileToStaticDir = async ({
  collection,
  file,
  source,
}: {
  collection: SanitizedCollectionConfig
  file: MediaFile
  source: string
}): Promise<void> => {
  const destination = resolveInside(getStaticDir(collection), file.filename)
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  await fsp.copyFile(source, destination)
}

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

export const isLocalUploadCollection = (collection: SanitizedCollectionConfig): boolean =>
  !collection.upload.disableLocalStorage
