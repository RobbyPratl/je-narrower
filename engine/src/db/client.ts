import pg from 'pg';

const { Pool } = pg;

/** Minimal database surface used by query-only services and transactional work. */
export type Db = Pick<pg.Pool, 'query'>;

export function createPool(): pg.Pool {
  return new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgres://je:je@localhost:5432/je_narrower',
  });
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
