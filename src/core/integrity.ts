import type { Payload } from 'payload'

import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'

import type { BackupManifest, SanitizedBackupPluginConfig } from '../types.js'

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

export const sha256File = async (filePath: string): Promise<string> => {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

/* ------------------------------------------------------------------------- */
/* File checksums and the manifest signature                                  */
/* ------------------------------------------------------------------------- */

/** Every file below `dir` (following symlinks), as sorted posix paths relative to `dir`. */
const listFiles = async (dir: string, base = dir): Promise<string[]> => {
  const files: string[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const isDirectory =
      entry.isDirectory() || (entry.isSymbolicLink() && (await fsp.stat(full)).isDirectory())
    if (isDirectory) {
      files.push(...(await listFiles(full, base)))
    } else {
      files.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return files.sort()
}

/** SHA-256 of every file of an archive folder, except the manifest itself. */
export const hashArchiveContents = async (dir: string): Promise<Record<string, string>> => {
  const checksums: Record<string, string> = {}
  for (const file of await listFiles(dir)) {
    if (file !== 'manifest.json') {
      checksums[file] = await sha256File(path.join(dir, ...file.split('/')))
    }
  }
  return checksums
}

/**
 * Compares an extracted archive with the checksums in its manifest.
 * @returns a description of every difference (empty when everything matches)
 */
export const checkArchiveContents = async (
  dir: string,
  checksums: Record<string, string>,
): Promise<string[]> => {
  const problems: string[] = []
  const actual = await hashArchiveContents(dir)
  for (const [file, hash] of Object.entries(checksums)) {
    if (!(file in actual)) {
      problems.push(`${file} is missing from the archive.`)
    } else if (actual[file] !== hash) {
      problems.push(`${file} was changed after the backup was taken.`)
    }
  }
  for (const file of Object.keys(actual)) {
    if (!(file in checksums)) {
      problems.push(`${file} was added to the archive after the backup was taken.`)
    }
  }
  return problems
}

const deriveKey = (secret: string, purpose: string): Buffer =>
  crypto.createHmac('sha256', secret).update(`payload-plugin-backup:${purpose}`).digest()

/**
 * Keys that may have signed an archive: `signingSecret` (or the site's
 * PAYLOAD_SECRET) first, then any previous secrets.
 */
const getSigningKeys = (payload: Payload, options: SanitizedBackupPluginConfig): Buffer[] =>
  [options.signing.secret ?? payload.secret, ...options.signing.previousSecrets]
    .filter((secret): secret is string => Boolean(secret))
    .map((secret) => deriveKey(secret, 'manifest-signature'))

/** What gets signed: the manifest without its signature, as compact JSON. */
const signingInput = (manifest: BackupManifest): string => {
  const { signature: _signature, ...rest } = manifest
  return JSON.stringify(rest)
}

const hmac = (key: Buffer, input: string) => crypto.createHmac('sha256', key).update(input).digest()

export const signManifest = (
  manifest: BackupManifest,
  payload: Payload,
  options: SanitizedBackupPluginConfig,
): string => hmac(getSigningKeys(payload, options)[0], signingInput(manifest)).toString('hex')

/**
 * Whether the manifest was signed by this site (with its signing secret or a
 * previous one). Together with the file checksums inside the manifest, a valid
 * signature proves that nobody changed or forged the archive.
 */
export const isSignedBySite = (
  manifest: BackupManifest,
  payload: Payload,
  options: SanitizedBackupPluginConfig,
): boolean => {
  if (typeof manifest.signature !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.signature)) {
    return false
  }
  const given = Buffer.from(manifest.signature, 'hex')
  const input = signingInput(manifest)
  return getSigningKeys(payload, options).some((key) =>
    crypto.timingSafeEqual(hmac(key, input), given),
  )
}

/* ------------------------------------------------------------------------- */
/* Encryption                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Encrypted archive layout:
 *
 *   "PBKPENC1" (8 bytes) | salt (16 bytes) | chunk | chunk | ...
 *   chunk = length (uint32 BE) | final flag (1 byte) | iv (12 bytes) | ciphertext | tag (16 bytes)
 *
 * Each chunk is sealed with AES-256-GCM. The salt, the chunk number and the
 * final flag are authenticated too, so chunks can't be reordered, removed or
 * cut off without decryption failing.
 */
const MAGIC = Buffer.from('PBKPENC1')
const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const CHUNK_SIZE = 1024 * 1024

const deriveEncryptionKey = (secret: string, salt: Buffer) => scrypt(secret, salt, 32)

const chunkAAD = (salt: Buffer, index: number, final: boolean) => {
  const aad = Buffer.alloc(SALT_LENGTH + 5)
  salt.copy(aad, 0)
  aad.writeUInt32BE(index, SALT_LENGTH)
  aad.writeUInt8(final ? 1 : 0, SALT_LENGTH + 4)
  return aad
}

export const isEncryptedFile = async (filePath: string): Promise<boolean> => {
  const handle = await fsp.open(filePath, 'r')
  try {
    const header = Buffer.alloc(MAGIC.length)
    const { bytesRead } = await handle.read(header, 0, MAGIC.length, 0)
    return bytesRead === MAGIC.length && header.equals(MAGIC)
  } finally {
    await handle.close()
  }
}

export const encryptFile = async ({
  input,
  output,
  secret,
}: {
  input: string
  output: string
  secret: string
}): Promise<void> => {
  const salt = crypto.randomBytes(SALT_LENGTH)
  const key = await deriveEncryptionKey(secret, salt)

  const seal = (plain: Buffer, index: number, final: boolean): Buffer => {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(chunkAAD(salt, index, final))
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const header = Buffer.alloc(5)
    header.writeUInt32BE(plain.length, 0)
    header.writeUInt8(final ? 1 : 0, 4)
    return Buffer.concat([header, iv, encrypted, cipher.getAuthTag()])
  }

  async function* chunks(): AsyncGenerator<Buffer> {
    yield Buffer.concat([MAGIC, salt])
    let index = 0
    let pending: Buffer | undefined
    for await (const chunk of fs.createReadStream(input, { highWaterMark: CHUNK_SIZE })) {
      if (pending) {
        yield seal(pending, index++, false)
      }
      pending = chunk as Buffer
    }
    yield seal(pending ?? Buffer.alloc(0), index, true)
  }

  await pipeline(Readable.from(chunks()), fs.createWriteStream(output))
}

/** Reads exactly the requested number of bytes from a stream of chunks. */
const createByteReader = (source: AsyncIterator<Buffer>) => {
  let buffered = Buffer.alloc(0)
  return async (length: number): Promise<Buffer | undefined> => {
    while (buffered.length < length) {
      const { done, value } = await source.next()
      if (done) {
        return undefined
      }
      buffered = Buffer.concat([buffered, value])
    }
    const result = buffered.subarray(0, length)
    buffered = buffered.subarray(length)
    return result
  }
}

/**
 * Decrypts an encrypted archive with the first of `secrets` that fits.
 * Throws when none fits or the file was changed or cut off.
 */
export const decryptFile = async ({
  input,
  output,
  secrets,
}: {
  input: string
  output: string
  secrets: string[]
}): Promise<void> => {
  const source = fs.createReadStream(input, { highWaterMark: CHUNK_SIZE })[Symbol.asyncIterator]()
  const read = createByteReader(source as AsyncIterator<Buffer>)

  const header = await read(MAGIC.length + SALT_LENGTH)
  if (!header || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('This file is not an encrypted Payload backup.')
  }
  const salt = header.subarray(MAGIC.length)

  const readChunk = async () => {
    const chunkHeader = await read(5)
    if (!chunkHeader) {
      return undefined
    }
    const length = chunkHeader.readUInt32BE(0)
    if (length > CHUNK_SIZE) {
      throw new Error('The encrypted backup is damaged.')
    }
    const final = chunkHeader.readUInt8(4) === 1
    const iv = await read(IV_LENGTH)
    const encrypted = await read(length)
    const tag = await read(TAG_LENGTH)
    if (!iv || !encrypted || !tag) {
      throw new Error('The encrypted backup is incomplete: it was cut off.')
    }
    return { encrypted, final, iv, tag }
  }

  const open = (key: Buffer, chunk: NonNullable<Awaited<ReturnType<typeof readChunk>>>, index: number) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, chunk.iv)
    decipher.setAAD(chunkAAD(salt, index, chunk.final))
    decipher.setAuthTag(chunk.tag)
    return Buffer.concat([decipher.update(chunk.encrypted), decipher.final()])
  }

  const first = await readChunk()
  if (!first) {
    throw new Error('The encrypted backup is incomplete: it was cut off.')
  }

  // Find the key that opens the first chunk.
  let key: Buffer | undefined
  let firstPlain: Buffer | undefined
  for (const secret of secrets) {
    const candidate = await deriveEncryptionKey(secret, salt)
    try {
      firstPlain = open(candidate, first, 0)
      key = candidate
      break
    } catch {
      // wrong key, try the next one
    }
  }
  if (!key || !firstPlain) {
    throw new Error(
      'Could not decrypt the backup: none of the configured encryption keys fits, or the file is damaged.',
    )
  }

  async function* plain(): AsyncGenerator<Buffer> {
    yield firstPlain!
    let final = first!.final
    let index = 1
    while (!final) {
      const chunk = await readChunk()
      if (!chunk) {
        throw new Error('The encrypted backup is incomplete: it was cut off.')
      }
      try {
        yield open(key!, chunk, index++)
      } catch {
        throw new Error('The encrypted backup was changed or damaged.')
      }
      final = chunk.final
    }
    if (await read(1)) {
      throw new Error('The encrypted backup has unexpected data at the end.')
    }
  }

  await pipeline(Readable.from(plain()), fs.createWriteStream(output))
}

/** Secrets that may decrypt an archive: the current key first, then previous ones. */
export const getDecryptionSecrets = (options: SanitizedBackupPluginConfig): string[] =>
  [options.encryption?.key, ...(options.encryption?.previousKeys ?? [])].filter(
    (secret): secret is string => Boolean(secret),
  )

/**
 * Returns the path of a plain `.tar.gz` for an archive on disk, decrypting it
 * next to the original when it is encrypted.
 */
export const openArchive = async ({
  archivePath,
  options,
}: {
  archivePath: string
  options: SanitizedBackupPluginConfig
}): Promise<{ encrypted: boolean; tarPath: string }> => {
  if (!(await isEncryptedFile(archivePath))) {
    return { encrypted: false, tarPath: archivePath }
  }
  const secrets = getDecryptionSecrets(options)
  if (!secrets.length) {
    throw new Error(
      'This backup is encrypted. Set `encryption.key` in the backup plugin options to the key it was encrypted with.',
    )
  }
  const tarPath = `${archivePath}.decrypted.tar.gz`
  await decryptFile({ input: archivePath, output: tarPath, secrets })
  return { encrypted: true, tarPath }
}
