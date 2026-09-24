/**
 * Generates src/database.types.ts by introspecting a live database.
 *
 * `supabase gen types` is the preferred path and is what `pnpm gen:types`
 * runs, but it shells out to Docker even when given a --db-url. This
 * script is the fallback for environments without Docker (CI, and any
 * machine running the bare-Postgres harness in test/). It reads the same
 * catalogs and emits the same shape, so the checked-in types stay derived
 * from the schema rather than hand-maintained.
 *
 *   node scripts/generate-types.mjs "postgresql://postgres@localhost:55432/pps_test"
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const connectionString = process.argv[2];
if (!connectionString) {
  console.error('usage: node scripts/generate-types.mjs <connection-string>');
  process.exit(1);
}

/** Postgres base type -> TypeScript. Anything unlisted falls back to string. */
const TS_TYPES = {
  uuid: 'string',
  text: 'string',
  varchar: 'string',
  timestamptz: 'string',
  timestamp: 'string',
  date: 'string',
  int2: 'number',
  int4: 'number',
  int8: 'number',
  float4: 'number',
  float8: 'number',
  numeric: 'number',
  bool: 'boolean',
  jsonb: 'Json',
  json: 'Json',
};

function tsTypeFor(udtName) {
  if (udtName === 'vector') return 'string';
  return TS_TYPES[udtName] ?? 'string';
}

const client = new pg.Client({ connectionString });
await client.connect();

const { rows: columns } = await client.query(`
  select c.relname                        as table_name,
         a.attname                        as column_name,
         t.typname                        as udt_name,
         not a.attnotnull                 as is_nullable,
         pg_get_expr(d.adbin, d.adrelid) is not null as has_default,
         a.attidentity <> ''              as is_identity
    from pg_attribute a
    join pg_class c     on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type t      on t.oid = a.atttypid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname = 'public'
     and c.relkind = 'r'
     and a.attnum > 0
     and not a.attisdropped
   order by c.relname, a.attnum
`);

const { rows: fks } = await client.query(`
  select con.conname                as constraint_name,
         child.relname              as table_name,
         parent.relname             as foreign_table,
         att.attname                as column_name,
         fatt.attname               as foreign_column
    from pg_constraint con
    join pg_class child  on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_namespace n  on n.oid = child.relnamespace
    join lateral unnest(con.conkey)  with ordinality as ck(attnum, ord) on true
    join lateral unnest(con.confkey) with ordinality as fk(attnum, ord) on ck.ord = fk.ord
    join pg_attribute att  on att.attrelid  = con.conrelid  and att.attnum  = ck.attnum
    join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = fk.attnum
   where con.contype = 'f' and n.nspname = 'public'
   order by child.relname, con.conname
`);

const { rows: functions } = await client.query(`
  select p.proname as name,
         pg_get_function_arguments(p.oid) as args,
         pg_get_function_result(p.oid)    as result
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
   order by p.proname
`);

const { rows: enums } = await client.query(`
  select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
   group by t.typname
   order by t.typname
`);

await client.end();

const tables = new Map();
for (const column of columns) {
  if (!tables.has(column.table_name)) tables.set(column.table_name, []);
  tables.get(column.table_name).push(column);
}

/** SQL argument and return types, spelled the way pg_get_function_* emits them. */
const ARG_TS = {
  uuid: 'string',
  text: 'string',
  interval: 'string',
  integer: 'number',
  bigint: 'number',
  numeric: 'number',
  boolean: 'boolean',
  jsonb: 'Json',
  json: 'Json',
  'timestamp with time zone': 'string',
  'double precision': 'number',
};

function renderArgs(args) {
  if (args.trim() === '') return 'Record<PropertyKey, never>';
  const fields = args.split(',').map((raw) => {
    const declaration = raw.trim();
    const hasDefault = / DEFAULT /i.test(declaration);
    const withoutDefault = declaration.split(/ DEFAULT /i)[0].trim();
    const name = withoutDefault.split(/\s+/)[0];
    const type = withoutDefault.slice(name.length).trim();
    // Every SQL argument accepts NULL - the type system has no way to
    // forbid it - so the generated types say so rather than pretending.
    return `          ${name}${hasDefault ? '?' : ''}: ${sqlArgType(type)} | null;`;
  });
  return `{\n${fields.join('\n')}\n        }`;
}

/** Maps a SQL argument type, including array types, to TypeScript. */
function sqlArgType(type) {
  if (type.endsWith('[]')) {
    return `${ARG_TS[type.slice(0, -2).trim()] ?? 'string'}[]`;
  }
  return ARG_TS[type] ?? 'string';
}

function renderReturn(result) {
  if (result === 'void') return 'undefined';
  return ARG_TS[result] ?? 'string';
}

const lines = [];
lines.push('/**');
lines.push(' * GENERATED FILE - do not edit by hand.');
lines.push(' *');
lines.push(' * Regenerate after every migration with `pnpm --filter @pps/db gen:types`,');
lines.push(' * or `pnpm --filter @pps/db gen:types:pg` on a machine without Docker.');
lines.push(' * Checked in on purpose so a clone can typecheck without a database.');
lines.push(' */');
lines.push('');
lines.push('export type Json =');
lines.push('  | string');
lines.push('  | number');
lines.push('  | boolean');
lines.push('  | null');
lines.push('  | { [key: string]: Json | undefined }');
lines.push('  | Json[];');
lines.push('');
lines.push('export interface Database {');
lines.push('  public: {');
lines.push('    Tables: {');

for (const [table, cols] of tables) {
  lines.push(`      ${table}: {`);
  for (const kind of ['Row', 'Insert', 'Update']) {
    lines.push(`        ${kind}: {`);
    for (const col of cols) {
      const base = tsTypeFor(col.udt_name);
      const nullable = col.is_nullable ? ' | null' : '';
      let optional = '';
      if (kind === 'Update') optional = '?';
      else if (kind === 'Insert' && (col.is_nullable || col.has_default || col.is_identity)) {
        optional = '?';
      }
      lines.push(`          ${col.column_name}${optional}: ${base}${nullable};`);
    }
    lines.push('        };');
  }
  const related = fks.filter((fk) => fk.table_name === table);
  if (related.length === 0) {
    lines.push('        Relationships: [];');
  } else {
    lines.push('        Relationships: [');
    for (const fk of related) {
      lines.push('          {');
      lines.push(`            foreignKeyName: '${fk.constraint_name}';`);
      lines.push(`            columns: ['${fk.column_name}'];`);
      lines.push('            isOneToOne: false;');
      lines.push(`            referencedRelation: '${fk.foreign_table}';`);
      lines.push(`            referencedColumns: ['${fk.foreign_column}'];`);
      lines.push('          },');
    }
    lines.push('        ];');
  }
  lines.push('      };');
}

lines.push('    };');
lines.push('    Views: Record<never, never>;');
lines.push('    Functions: {');
for (const fn of functions) {
  lines.push(`      ${fn.name}: {`);
  lines.push(`        Args: ${renderArgs(fn.args)};`);
  lines.push(`        Returns: ${renderReturn(fn.result)};`);
  lines.push('      };');
}
lines.push('    };');
if (enums.length === 0) {
  lines.push('    Enums: Record<never, never>;');
} else {
  lines.push('    Enums: {');
  for (const e of enums) {
    lines.push(`      ${e.name}: ${e.labels.map((l) => `'${l}'`).join(' | ')};`);
  }
  lines.push('    };');
}
lines.push('    CompositeTypes: Record<never, never>;');
lines.push('  };');
lines.push('}');
lines.push('');
lines.push("export type Tables<T extends keyof Database['public']['Tables']> =");
lines.push("  Database['public']['Tables'][T]['Row'];");
lines.push("export type Inserts<T extends keyof Database['public']['Tables']> =");
lines.push("  Database['public']['Tables'][T]['Insert'];");
lines.push("export type Updates<T extends keyof Database['public']['Tables']> =");
lines.push("  Database['public']['Tables'][T]['Update'];");
lines.push('');

const target = fileURLToPath(new URL('../src/database.types.ts', import.meta.url));
writeFileSync(target, lines.join('\n'));
console.log(`wrote ${target} (${tables.size} tables, ${functions.length} functions)`);
