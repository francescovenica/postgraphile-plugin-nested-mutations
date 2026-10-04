/*
 * Dumps every table in a schema as JSON (rows sorted by their JSON text) so
 * database state after a GraphQL operation can be compared with the golden
 * recordings.
 *
 * `query(text, values)` must resolve to `{ rows }` (node-postgres style).
 */
const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function dumpSchema(query, schemaName = 'p') {
  const { rows: tables } = await query(
    `select c.relname
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p')
      order by c.relname`,
    [schemaName],
  );
  const out = {};
  for (const { relname } of tables) {
    const { rows } = await query(
      `select coalesce(
         json_agg(row_to_json(t) order by row_to_json(t)::text),
         '[]'::json
       ) as rows
       from ${quoteIdent(schemaName)}.${quoteIdent(relname)} t`,
    );
    out[relname] = rows[0].rows;
  }
  return out;
}

/**
 * Resets per-operation session settings (role, JWT claims) applied with
 * `set_config(..., true)` so the dump runs as the test superuser.
 */
async function resetSettings(query, pgSettings) {
  await query('reset role');
  for (const key of Object.keys(pgSettings || {})) {
    if (key === 'role') continue;
    await query(`select set_config($1, '', true)`, [key]);
  }
}

module.exports = { dumpSchema, resetSettings, quoteIdent };
