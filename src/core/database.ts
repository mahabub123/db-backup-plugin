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
