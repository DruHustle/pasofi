import { readFile } from 'node:fs/promises';

const policies = JSON.parse(await readFile(new URL('./role-policies.json', import.meta.url), 'utf8'));
const identifier = value => { if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw Error('Invalid database identifier.'); return `"${value}"`; };

export async function applyRuntimeGrants(client, { service, owner, runtime }) {
  if (!Object.hasOwn(policies, service)) throw Error('Unknown service grant policy.');
  const policy = { schema_migrations: ['SELECT'], ...policies[service] };
  const actor = (await client.query('SELECT current_user AS name')).rows[0].name;
  if (actor !== owner) throw Error('Migrations and grants must run as the non-login object owner.');
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
  if (tables.some(name => !Object.hasOwn(policy, name)) || Object.keys(policy).some(name => !tables.includes(name))) throw Error('Owned schema and reviewed runtime grant manifest differ. Review every new table before releasing.');
  const sequences = (await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public'")).rows;
  if (sequences.length) throw Error('New sequences require an explicit runtime usage policy before release.');
  await client.query('BEGIN');
  try {
    // Reset grants so this is equally safe after a rollback/forward release.
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, ${identifier(runtime)}`);
    // Table-level REVOKE does not remove earlier column-level privileges.
    const columns = (await client.query("SELECT DISTINCT table_name,column_name FROM information_schema.column_privileges WHERE table_schema='public' AND grantee=$1", [runtime])).rows;
    for (const column of columns) {
      const name = identifier(column.column_name);
      await client.query(`REVOKE SELECT (${name}),INSERT (${name}),UPDATE (${name}),REFERENCES (${name}) ON TABLE public.${identifier(column.table_name)} FROM ${identifier(runtime)}`);
    }
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, ${identifier(runtime)}`);
    await client.query(`REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, ${identifier(runtime)}`);
    for (const [table, privileges] of Object.entries(policy)) {
      if (!privileges.length) continue;
      if (privileges.some(value => !/^(SELECT|INSERT|UPDATE|DELETE|UPDATE \((id|request_hash)\))$/.test(value))) throw Error('Invalid runtime grant policy.');
      await client.query(`GRANT ${privileges.join(',')} ON TABLE public.${identifier(table)} TO ${identifier(runtime)}`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
