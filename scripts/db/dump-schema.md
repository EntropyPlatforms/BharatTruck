# Regenerating `supabase/schema/baseline.sql`

This is a documented SQL procedure, not a shell script. Run each query against the live
project, paste its rows into the corresponding section of `baseline.sql`, then run the
verification at the bottom.

## Why there is no `pg_dump` script

`pg_dump --schema-only` would do all of this in one command and would be the right tool.
We cannot use it: it needs a direct Postgres connection, and **this repo has no database
password and no connection string** — not in `.env`, not in CI secrets, not in Secret
Manager. The credential exists only in the founder's Supabase dashboard. The access path
that agents and engineers actually have is the Supabase MCP server's `execute_sql`, which
runs one statement and returns rows; it cannot stream a dump file.

So the procedure below reconstructs what `pg_dump` would emit, out of the same catalog
functions `pg_dump` itself calls (`pg_get_constraintdef`, `pg_get_functiondef`,
`pg_get_triggerdef`, `pg_get_viewdef`, `pg_indexes.indexdef`). The bodies are byte-for-byte
what Postgres reports.

If someone does obtain the database password, this file becomes obsolete and should be
replaced by:

```bash
pg_dump --schema-only --schema=public --no-owner --no-privileges "$DATABASE_URL" \
  > supabase/schema/baseline.sql
# note: --no-privileges would drop section 13, so run WITH privileges, or keep
# section 13 as a separate hand-maintained appendix from the grants query below.
```

## Project

- Supabase project: `bharattruck-mvp`, ref `rxbdzbcndpzznvqcbimg`, PostgreSQL 17.6
- Access: Supabase MCP `execute_sql` (read-only usage is enough for all of this)
- Everything below is a `SELECT`. **None of it modifies the database.**

## Conventions used by every query

- Only schema `public`.
- Objects owned by an extension are excluded via
  `not exists (select 1 from pg_depend d where d.objid = <oid> and d.deptype = 'e')`.
  This is what drops PostGIS's `spatial_ref_sys`, `geometry_columns`, `geography_columns`
  and its 744 functions without hard-coding their names.
- Indexes that back a PK/UNIQUE constraint are excluded via
  `not exists (select 1 from pg_constraint con where con.conindid = <index oid>)` — i.e.
  identified by the constraint pointing at the index OID, never by name matching.

---

## 1. Extensions

```sql
select e.extname, e.extversion, ne.nspname as schema
from pg_extension e join pg_namespace ne on ne.oid = e.extnamespace
order by e.extname;
```

## 2. Enum types

Emits ready-to-paste `CREATE TYPE`. `enumsortorder` is the semantic order — never
re-sort the labels.

```sql
select 'CREATE TYPE public.' || t.typname || ' AS ENUM ('
       || string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) || ');' as ddl
from pg_type t
join pg_enum e on e.enumtypid = t.oid
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public' and t.typtype = 'e'
group by t.typname
order by t.typname;
```

## 3. Tables

One row per column line, in `attnum` (physical) order. Wrap each table's lines in
`CREATE TABLE public.<relname> (` … `);`. Handles identity columns, generated-stored
columns and defaults in the same expression pg_dump uses.

```sql
select c.relname, a.attnum,
  '    ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod) ||
  case
    when a.attidentity <> '' then ' GENERATED '
      || (case a.attidentity when 'a' then 'ALWAYS' else 'BY DEFAULT' end) || ' AS IDENTITY'
    when a.attgenerated <> '' then ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
    when a.atthasdef then ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid)
    else ''
  end ||
  case when a.attnotnull then ' NOT NULL' else '' end as line
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where n.nspname = 'public' and c.relkind = 'r'
  and not exists (select 1 from pg_depend dd where dd.objid = c.oid and dd.deptype = 'e')
order by c.relname, a.attnum;
```

The result is large. Split it with a `and c.relname < 'f'` style predicate if the MCP
response is truncated; the ordering makes the batches contiguous.

## 4-6. Constraints

Three passes so the output file groups them. `contype`: `p` primary key, `u` unique,
`c` check, `f` foreign key. Change the `contype in (...)` list per pass.

```sql
select 'ALTER TABLE ONLY public.' || quote_ident(c.relname)
       || ' ADD CONSTRAINT ' || quote_ident(con.conname) || ' '
       || pg_get_constraintdef(con.oid) || ';' as stmt
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and con.contype in ('p','u')          -- then ('c'), then ('f')
  and not exists (select 1 from pg_depend dd where dd.objid = c.oid and dd.deptype = 'e')
order by c.relname, con.contype, con.conname;
```

`pg_get_constraintdef` already prints `NOT VALID` where it applies — do not add or drop it.

## 7. Indexes

```sql
select i.indexdef || ';' as stmt
from pg_indexes i
join pg_class ic on ic.relname = i.indexname
join pg_namespace inn on inn.oid = ic.relnamespace and inn.nspname = 'public'
where i.schemaname = 'public'
  and not exists (select 1 from pg_constraint con where con.conindid = ic.oid)
  and not exists (
    select 1 from pg_depend dd join pg_class tc on tc.oid = dd.objid
    where dd.deptype = 'e' and tc.relname = i.tablename and tc.relnamespace = inn.oid)
order by i.tablename, i.indexname;
```

## 8. Functions

`pg_get_functiondef` returns the complete `CREATE OR REPLACE FUNCTION` with no trailing
semicolon — add one. Paste bodies verbatim, comments included.

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by p.proname;
```

## 9. Triggers

```sql
select pg_get_triggerdef(tg.oid) || ';' as stmt
from pg_trigger tg
join pg_class c on c.oid = tg.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not tg.tgisinternal
order by c.relname, tg.tgname;
```

## 10. Views

```sql
select c.relname, pg_get_viewdef(c.oid, true) as def
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
order by c.relname;
```

Wrap each as `CREATE VIEW public.<relname> AS` + the returned body.

## 11. RLS

```sql
-- which tables have it on
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
order by c.relname;

-- policies
select 'CREATE POLICY ' || quote_ident(p.policyname) || ' ON public.' || quote_ident(p.tablename)
       || ' AS ' || p.permissive || ' FOR ' || p.cmd
       || ' TO ' || array_to_string(p.roles, ', ')
       || coalesce(' USING (' || p.qual || ')', '')
       || coalesce(' WITH CHECK (' || p.with_check || ')', '') || ';' as stmt
from pg_policies p
where p.schemaname = 'public'
order by p.tablename, p.policyname;
```

## 12. Comments

```sql
-- tables
select 'COMMENT ON TABLE public.' || quote_ident(c.relname) || ' IS '
       || quote_literal(obj_description(c.oid, 'pg_class')) || ';' as stmt
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and obj_description(c.oid, 'pg_class') is not null
  and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
order by c.relname;

-- columns
select 'COMMENT ON COLUMN public.' || quote_ident(c.relname) || '.' || quote_ident(a.attname)
       || ' IS ' || quote_literal(col_description(c.oid, a.attnum)) || ';' as stmt
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public' and col_description(c.oid, a.attnum) is not null
  and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
order by c.relname, a.attnum;

-- functions
select 'COMMENT ON FUNCTION public.' || p.proname
       || '(' || pg_get_function_identity_arguments(p.oid) || ') IS '
       || quote_literal(obj_description(p.oid, 'pg_proc')) || ';' as stmt
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and obj_description(p.oid, 'pg_proc') is not null
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by p.proname;
```

## 13. Grants

Table grants first — this query returns **only** rows that differ from the full-privilege
set, so an empty result means every table grants everything to every Supabase role and one
blanket `GRANT ALL ON ALL TABLES` line describes it:

```sql
select grantee, table_name,
       string_agg(distinct privilege_type, ', ' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated','service_role','PUBLIC')
group by grantee, table_name
having string_agg(distinct privilege_type, ', ' order by privilege_type)
     <> 'DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE'
order by table_name, grantee;
```

Function ACLs are not uniform, so read them raw. A missing `=X/postgres` entry means
EXECUTE has been revoked from PUBLIC; an explicit `anon=X` means `anon` can call it:

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.proacl::text as acl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by p.proname;
```

---

## Verification (do not skip)

Two steps. First, counts:

```sql
select
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r'
     and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')) as tables,
 (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
   where n.nspname='public' and t.typtype='e') as enums,
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')) as functions,
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='v'
     and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')) as views,
 (select count(*) from pg_trigger tg join pg_class c on c.oid=tg.tgrelid
   join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and not tg.tgisinternal) as triggers,
 (select count(*) from pg_policies where schemaname='public') as policies;
```

Second — and this is the one that catches a typo rather than a miscount — compare md5s of
the sorted object-name sets. Ask the database:

```sql
with cols as (
  select c.relname || '.' || a.attname as k
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  where n.nspname='public' and c.relkind='r'
    and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')
), cons as (
  select con.conname as k from pg_constraint con
  join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and con.contype in ('p','u','c','f')
    and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')
)
select (select md5(string_agg(k, E'\n' order by k)) from cols) as cols_md5,
       (select count(*) from cols) as cols_n,
       (select md5(string_agg(k, E'\n' order by k)) from cons) as cons_md5,
       (select count(*) from cons) as cons_n;
```

and compute the same from the file you just wrote:

```bash
nl_md5() { awk 'NR>1{printf "\n"}{printf "%s",$0}' | md5 -q; }   # md5sum on Linux

# table.column set
awk '/^CREATE TABLE public\./ { t=$3; sub(/^public\./,"",t); sub(/ .*/,"",t); next }
     /^\);/ { t="" ; next }
     t != "" && /^    [a-z_0-9]+ / { print t "." $1 }' supabase/schema/baseline.sql \
  | sort | nl_md5

# constraint-name set
grep -oE 'ADD CONSTRAINT [a-z_0-9]+' supabase/schema/baseline.sql \
  | sed 's/ADD CONSTRAINT //' | sort | nl_md5
```

The two md5s must be identical. `string_agg` emits no trailing newline, which is what the
`nl_md5` awk reproduces — a mismatch that disappears when you strip the trailing newline
is a formatting artefact, not a missing object. The same pattern works for index names,
policy `table|name` pairs, function names and trigger `table|name` pairs.

At the 2026-08-07 generation the verified values were: 62 tables / 793 columns / 346
constraints / 114 non-constraint indexes / 16 enums / 15 functions / 15 triggers / 2 views
/ 34 policies, with all seven md5 sets matching.
