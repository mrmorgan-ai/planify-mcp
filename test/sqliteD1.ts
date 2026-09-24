import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

const MIGRATIONS = new URL('../migrations/', import.meta.url)

/**
 * The part of D1 this Worker uses — prepare, bind, first — over an in-memory
 * SQLite with every migration applied, so the counter's statement is tested
 * against the schema it runs on. `sqlite` is exposed so a test can set the
 * count directly.
 */
export function sqliteD1(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }

  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    sql,
    params,
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    all: () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
  })

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((each) => each.all())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db: db as unknown as D1Database, sqlite }
}
