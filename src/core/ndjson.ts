import { once } from 'events'
import fs from 'fs'
import readline from 'readline'

/** Streams documents to a newline-delimited JSON file, one document per line. */
export const createNdjsonWriter = (filePath: string) => {
  const stream = fs.createWriteStream(filePath)
  let count = 0

  return {
    close: async (): Promise<number> => {
      stream.end()
      await once(stream, 'finish')
      return count
    },
    write: async (doc: unknown): Promise<void> => {
      count++
      if (!stream.write(`${JSON.stringify(doc)}\n`)) {
        await once(stream, 'drain')
      }
    },
  }
}

export async function* readNdjson<T = Record<string, unknown>>(filePath: string): AsyncGenerator<T> {
  const lines = readline.createInterface({
    crlfDelay: Infinity,
    input: fs.createReadStream(filePath),
  })

  for await (const line of lines) {
    if (line.trim()) {
      yield JSON.parse(line) as T
    }
  }
}
