import type { Payload, PayloadRequest } from 'payload'

/**
 * Helpers for the SQL adapters (Postgres, SQLite). Payload's SQL schemas use
 * foreign keys between collections, so documents that reference each other
 * (posts -> media -> users -> posts ...) cannot be inserted one by one in any
 * order. During a restore the foreign-key checks are postponed until the end of
 * the transaction, then verified all at once.
 */

type DrizzleAdapter = {
  drizzle: unknown
  execute: (args: { db?: unknown; drizzle?: unknown; raw: string }) => Promise<unknown>
  schemaName?: string
  sessions?: Record<string, { db: unknown }>
}

export type DatabaseKind = 'mongodb' | 'other' | 'postgres' | 'sqlite'

/** Works on a package name ('@payloadcms/db-postgres') or adapter name ('mongoose'). */
export const getAdapterKind = (name: string): DatabaseKind => {
  if (name.includes('mongo')) {
    return 'mongodb'
  }
  if (name.includes('postgres')) {
    return 'postgres'
  }
  if (name.includes('sqlite')) {
    return 'sqlite'
  }
  return 'other'
}

export const getDatabaseKind = (payload: Payload): DatabaseKind => {
  const kind = getAdapterKind(payload.db.packageName ?? '')
  return kind === 'other' ? getAdapterKind(payload.db.name) : kind
}

/**
 * MongoDB ends a transaction that runs longer than 60 seconds
 * (`transactionLifetimeLimitSeconds`), or whose snapshot is too old;
 * everything it did is discarded.
 */
export const isTransactionTimeout = (error: unknown): boolean => {
  const { code, codeName, message } = (error ?? {}) as {
    code?: number
    codeName?: string
    message?: string
  }
  return (
    code === 239 || // SnapshotTooOld
    code === 246 || // SnapshotUnavailable
    code === 251 || // NoSuchTransaction
    code === 290 || // TransactionExceededLifetimeLimitSeconds
    codeName === 'NoSuchTransaction' ||
    codeName === 'TransactionExceededLifetimeLimitSeconds' ||
    codeName === 'SnapshotTooOld' ||
    /Transaction .* has been aborted/.test(message ?? '')
  )
}

/**
 * Whether the adapter runs real transactions. Payload's SQLite adapter (and
 * Postgres or MongoDB with `transactionOptions: false`) returns no transaction
 * id, so restores are not atomic and backups have no consistent snapshot.
 */
export const supportsTransactions = (payload: Payload): boolean =>
  // Payload's `defaultBeginTransaction()` is an anonymous arrow that resolves to
  // null; the adapters' real ones are named functions. Opening a transaction to
  // find out would block other writers on SQLite.
  typeof payload.db.beginTransaction === 'function' && payload.db.beginTransaction.name !== ''

/**
 * Starts a read-only transaction that sees the database as it was at one
 * instant, so a backup is consistent even while editors keep working:
 *
 * - Postgres: REPEATABLE READ, READ ONLY
 * - MongoDB: a transaction with snapshot read concern (at most 60 seconds)
 *
 * Returns undefined when there is no such transaction. That includes SQLite:
 * Payload's SQLite transactions always take the write lock (BEGIN IMMEDIATE),
 * which would block every editor until the backup ends.
 */
export const beginReadSnapshot = async (payload: Payload): Promise<string | undefined> => {
  const kind = getDatabaseKind(payload)
  if (!supportsTransactions(payload) || (kind !== 'postgres' && kind !== 'mongodb')) {
    return undefined
  }
  const options =
    kind === 'postgres'
      ? { accessMode: 'read only', isolationLevel: 'repeatable read' }
      : { readConcern: { level: 'snapshot' } }
  const id = await payload.db.beginTransaction(options as never)
  return id ? String(id) : undefined
}

const quoteIdent = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

const getAdapter = (payload: Payload) => payload.db as unknown as DrizzleAdapter

const execute = async (payload: Payload, req: PayloadRequest, raw: string) => {
  const adapter = getAdapter(payload)
  const transactionID = req.transactionID ? await req.transactionID : undefined
  const db = (transactionID && adapter.sessions?.[transactionID]?.db) || adapter.drizzle
  return adapter.execute({ db, raw })
}

const getRows = (result: unknown): Record<string, unknown>[] =>
  ((result as { rows?: Record<string, unknown>[] })?.rows ?? [])

const getPostgresSchema = (payload: Payload) => getAdapter(payload).schemaName || 'public'

export type ForeignKeyState = {
  /** Postgres constraints that were made deferrable and must be switched back. */
  constraints: { name: string; table: string }[]
}

export const deferForeignKeys = async (
  payload: Payload,
  req: PayloadRequest,
): Promise<ForeignKeyState> => {
  const kind = getDatabaseKind(payload)
  const state: ForeignKeyState = { constraints: [] }

  if (kind === 'sqlite') {
    await execute(payload, req, 'PRAGMA defer_foreign_keys = ON')
  }

  if (kind === 'postgres') {
    const schema = getPostgresSchema(payload)
    const result = await execute(
      payload,
      req,
      `SELECT con.conname AS name, rel.relname AS table
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       WHERE con.contype = 'f' AND NOT con.condeferrable AND nsp.nspname = ${quoteLiteral(schema)}`,
    )

    for (const row of getRows(result)) {
      const constraint = { name: String(row.name), table: String(row.table) }
      await execute(
        payload,
        req,
        `ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(constraint.table)} ALTER CONSTRAINT ${quoteIdent(constraint.name)} DEFERRABLE INITIALLY IMMEDIATE`,
      )
      state.constraints.push(constraint)
    }

    await execute(payload, req, 'SET CONSTRAINTS ALL DEFERRED')
  }

  return state
}

/**
 * Checks every postponed foreign key (throws if the restored data is
 * inconsistent) and puts the constraints back the way Payload created them.
 */
export const restoreForeignKeys = async (
  payload: Payload,
  req: PayloadRequest,
  state: ForeignKeyState,
): Promise<void> => {
  if (getDatabaseKind(payload) !== 'postgres') {
    return
  }

  const schema = getPostgresSchema(payload)
  await execute(payload, req, 'SET CONSTRAINTS ALL IMMEDIATE')

  for (const constraint of state.constraints) {
    await execute(
      payload,
      req,
      `ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(constraint.table)} ALTER CONSTRAINT ${quoteIdent(constraint.name)} NOT DEFERRABLE`,
    )
  }
}

/**
 * Rows were inserted with their original ids, which does not advance Postgres
 * serial sequences. Move every sequence past the highest id so new documents
 * don't collide with restored ones.
 */
export const resetSequences = async (payload: Payload, req: PayloadRequest): Promise<void> => {
  if (getDatabaseKind(payload) !== 'postgres') {
    return
  }

  const schema = getPostgresSchema(payload)
  await execute(
    payload,
    req,
    `DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.table_name, c.column_name,
          pg_get_serial_sequence(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name), c.column_name) AS seq
        FROM information_schema.columns c
        WHERE c.table_schema = ${quoteLiteral(schema)}
          AND c.column_default LIKE 'nextval(%'
      LOOP
        IF r.seq IS NOT NULL THEN
          EXECUTE format(
            'SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I.%I), 0) + 1, false)',
            r.seq, r.column_name, ${quoteLiteral(schema)}, r.table_name
          );
        END IF;
      END LOOP;
    END $$;`,
  )
}
