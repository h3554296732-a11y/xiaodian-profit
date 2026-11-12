/** Real PL/pgSQL and ACL checks in isolated PGlite, without cloud credentials.
 * This is a single PostgreSQL connection, not a multi-session locking test.
 * node scripts/test-auth-sms-db.mjs
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

let checks = 0;
const identity = (number) => number.toString(16).padStart(64, "0");
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const catalogs = [];

for (const fresh of [false, true]) {
  const db = new PGlite();
  const label = fresh ? "fresh schema" : "ordered migrations";
  async function check(name, task) {
    await task();
    console.log(`ok ${++checks} - ${label}: ${name}`);
  }
  async function asRole(role, sql, params = []) {
    await db.exec("begin");
    try {
      await db.exec(`set local role ${role}`);
      const result = await db.query(sql, params);
      await db.exec("commit");
      return result.rows;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  }
  const claim = async (digest, claimId = first) =>
    (
      await asRole(
        "service_role",
        "select public.claim_auth_sms($1,$2) as result",
        [digest, claimId],
      )
    )[0].result;
  const finish = async (digest, claimId = first, sent = true) =>
    (
      await asRole(
        "service_role",
        "select public.finish_auth_sms($1,$2,$3) as result",
        [digest, claimId, sent],
      )
    )[0].result;
  const record = async (digest) =>
    (
      await db.query(
        "select * from auth_sms_private.sms_deliveries where digest=$1",
        [digest],
      )
    ).rows[0];
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      -- No BYPASSRLS: exercises the explicit service-only RLS policy too.
      create role service_role nologin;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable security invoker as $$
        select (nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'sub')::uuid
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    if (fresh) {
      await db.exec(
        await readFile(
          new URL("../supabase/schema.sql", import.meta.url),
          "utf8",
        ),
      );
    } else {
      const directory = new URL("../supabase/migrations/", import.meta.url);
      for (const file of (await readdir(directory))
        .filter((file) => file.endsWith(".sql"))
        .sort())
        await db.exec(await readFile(new URL(file, directory), "utf8"));
    }

    await check(
      "stored columns contain identities and state, never phone or OTP",
      async () => {
        const { rows } = await db.query(
          "select column_name from information_schema.columns where table_schema='auth_sms_private' and table_name='sms_deliveries' order by ordinal_position",
        );
        assert.deepEqual(
          rows.map((row) => row.column_name),
          ["digest", "claim_id", "state", "lease_until", "updated_at"],
        );
      },
    );
    await check(
      "private table enables RLS and has indexed expiration order",
      async () => {
        const { rows } = await db.query(
          "select relrowsecurity from pg_class where oid='auth_sms_private.sms_deliveries'::regclass",
        );
        assert.equal(rows[0].relrowsecurity, true);
        const indexes = await db.query(
          "select indexdef from pg_indexes where schemaname='auth_sms_private' and indexname='sms_deliveries_expiry_idx'",
        );
        assert.match(indexes.rows[0].indexdef, /\(lease_until, digest\)/);
      },
    );
    await check(
      "RPCs are invoker functions with explicit search path and database timeouts",
      async () => {
        const { rows } = await db.query(
          "select proname,prosecdef,proconfig,prosrc,proacl::text as acl from pg_proc where oid in ('public.claim_auth_sms(text,uuid)'::regprocedure,'public.finish_auth_sms(text,uuid,boolean)'::regprocedure) order by proname",
        );
        assert.equal(rows.length, 2);
        for (const row of rows) {
          assert.equal(row.prosecdef, false);
          assert.ok(row.proconfig.includes('search_path=""'));
          assert.ok(row.proconfig.includes("statement_timeout=450ms"));
          assert.ok(row.proconfig.includes("lock_timeout=100ms"));
        }
        catalogs.push(rows);
      },
    );
    await check(
      "only service_role receives RPC execution; no PUBLIC execute grant",
      async () => {
        const { rows } = await db.query(`select p.proname,
        has_function_privilege('service_role',p.oid,'EXECUTE') as service,
        has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
        exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public
        from pg_proc p where p.oid in ('public.claim_auth_sms(text,uuid)'::regprocedure,'public.finish_auth_sms(text,uuid,boolean)'::regprocedure)`);
        for (const row of rows)
          assert.deepEqual(
            [row.service, row.anonymous, row.authenticated, row.public],
            [true, false, false, false],
          );
      },
    );
    await check(
      "service_role has only schema usage and necessary table DML",
      async () => {
        const { rows } = await db.query(`select
        has_schema_privilege('service_role','auth_sms_private','USAGE') as usage,
        has_schema_privilege('service_role','auth_sms_private','CREATE') as create,
        (has_table_privilege('service_role','auth_sms_private.sms_deliveries','SELECT')
          and has_table_privilege('service_role','auth_sms_private.sms_deliveries','INSERT')
          and has_table_privilege('service_role','auth_sms_private.sms_deliveries','UPDATE')
          and has_table_privilege('service_role','auth_sms_private.sms_deliveries','DELETE')) as dml,
        has_table_privilege('service_role','auth_sms_private.sms_deliveries','TRUNCATE') as truncate,
        has_table_privilege('service_role','auth_sms_private.sms_deliveries','TRIGGER') as trigger`);
        assert.deepEqual(rows[0], {
          usage: true,
          create: false,
          dml: true,
          truncate: false,
          trigger: false,
        });
      },
    );
    for (const role of ["anon", "authenticated"]) {
      await check(`${role} cannot use private schema or table`, async () => {
        const { rows } = await db.query(
          "select has_schema_privilege($1,'auth_sms_private','USAGE') as usage,has_table_privilege($1,'auth_sms_private.sms_deliveries','SELECT,INSERT,UPDATE,DELETE') as dml",
          [role],
        );
        assert.deepEqual(rows[0], { usage: false, dml: false });
        await assert.rejects(
          asRole(role, "select * from auth_sms_private.sms_deliveries"),
          { code: "42501" },
        );
      });
      await check(`${role} cannot call either SMS RPC`, async () => {
        await assert.rejects(
          asRole(role, "select public.claim_auth_sms($1,$2)", [
            identity(1),
            first,
          ]),
          { code: "42501" },
        );
        await assert.rejects(
          asRole(role, "select public.finish_auth_sms($1,$2,true)", [
            identity(1),
            first,
          ]),
          { code: "42501" },
        );
      });
    }
    await check("new claim is pending and lasts 45 seconds", async () => {
      assert.equal(await claim(identity(1)), "claimed");
      const row = await record(identity(1));
      assert.equal(row.claim_id, first);
      assert.equal(row.state, "pending");
      const seconds = (row.lease_until - row.updated_at) / 1000;
      assert.ok(seconds >= 44.9 && seconds <= 45.1);
    });
    await check(
      "duplicate pending claim blocks even if the caller reuses its UUID",
      async () => {
        assert.equal(await claim(identity(1), second), "blocked");
        assert.equal(await claim(identity(1), first), "blocked");
        assert.equal((await record(identity(1))).claim_id, first);
      },
    );
    await check(
      "wrong lease owner cannot finalize or change pending state",
      async () => {
        assert.equal(await finish(identity(1), second), false);
        assert.equal((await record(identity(1))).state, "pending");
      },
    );
    await check(
      "successful finalization answers duplicate claim without another send",
      async () => {
        assert.equal(await finish(identity(1)), true);
        assert.equal(await claim(identity(1), second), "sent");
        assert.equal((await record(identity(1))).claim_id, first);
      },
    );
    await check(
      "terminal sent result cannot be finalized twice or downgraded",
      async () => {
        assert.equal(await finish(identity(1)), false);
        assert.equal(await finish(identity(1), first, false), false);
        assert.equal((await record(identity(1))).state, "sent");
      },
    );
    await check(
      "uncertain provider result becomes unknown and blocks further claims",
      async () => {
        assert.equal(await claim(identity(2)), "claimed");
        assert.equal(await finish(identity(2), first, false), true);
        assert.equal(await claim(identity(2), second), "blocked");
        assert.equal(await finish(identity(2)), false);
        assert.equal((await record(identity(2))).state, "unknown");
      },
    );
    await check(
      "expired sent lease may be acquired by a normal later resend",
      async () => {
        await db.query(
          "update auth_sms_private.sms_deliveries set lease_until=clock_timestamp()-interval '1 second' where digest=$1",
          [identity(1)],
        );
        assert.equal(await claim(identity(1), second), "claimed");
        const row = await record(identity(1));
        assert.equal(row.claim_id, second);
        assert.equal(row.state, "pending");
        assert.ok(row.lease_until > new Date());
      },
    );
    await check(
      "former lease cannot overwrite newer lease; current owner can complete",
      async () => {
        assert.equal(await finish(identity(1), first, true), false);
        assert.equal(await finish(identity(1), first, false), false);
        assert.equal(await finish(identity(1), second), true);
        assert.equal((await record(identity(1))).state, "sent");
      },
    );
    await check(
      "expired pending owner cannot report success or failure",
      async () => {
        assert.equal(await claim(identity(3)), "claimed");
        await db.query(
          "update auth_sms_private.sms_deliveries set lease_until=clock_timestamp()-interval '1 second' where digest=$1",
          [identity(3)],
        );
        assert.equal(await finish(identity(3)), false);
        assert.equal(await finish(identity(3), first, false), false);
        assert.equal((await record(identity(3))).state, "pending");
        assert.equal(await claim(identity(3), second), "claimed");
      },
    );
    await check("missing delivery cannot be finalized", async () =>
      assert.equal(await finish(identity(999)), false),
    );
    await check(
      "RPC parameters reject invalid digest, null claim and null result",
      async () => {
        for (const digest of [
          null,
          "",
          "0".repeat(63),
          "A".repeat(64),
          "g".repeat(64),
        ]) {
          await assert.rejects(claim(digest), { code: "22023" });
          await assert.rejects(finish(digest), { code: "22023" });
        }
        await assert.rejects(claim(identity(4), null), { code: "22023" });
        await assert.rejects(finish(identity(4), null), { code: "22023" });
        await assert.rejects(finish(identity(4), first, null), {
          code: "22023",
        });
      },
    );
    await check(
      "table rejects invalid states and digest values independently of RPCs",
      async () => {
        await assert.rejects(
          asRole(
            "service_role",
            "insert into auth_sms_private.sms_deliveries values ($1,$2,'retry',now(),now())",
            [identity(4), first],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          asRole(
            "service_role",
            "insert into auth_sms_private.sms_deliveries values ('bad',$1,'pending',now(),now())",
            [first],
          ),
          { code: "23514" },
        );
      },
    );
    await check(
      "cleanup removes at most 100 records and keeps recent or active leases",
      async () => {
        await db.exec("truncate auth_sms_private.sms_deliveries");
        for (let index = 0; index < 105; index++)
          await db.query(
            "insert into auth_sms_private.sms_deliveries values ($1,$2,'unknown',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours')",
            [identity(index), first],
          );
        await db.query(
          "insert into auth_sms_private.sms_deliveries values ($1,$3,'pending',clock_timestamp()-interval '1 minute',now()),($2,$3,'sent',clock_timestamp()+interval '45 seconds',now())",
          [identity(200), identity(201), first],
        );
        assert.equal(await claim(identity(201), second), "sent");
        const { rows } = await db.query(
          "select count(*)::int as count from auth_sms_private.sms_deliveries",
        );
        assert.equal(rows[0].count, 7);
        assert.equal((await record(identity(200))).state, "pending");
        assert.equal((await record(identity(201))).state, "sent");
        assert.equal(await claim(identity(201), second), "sent");
        const remaining = await db.query(
          "select count(*)::int as count from auth_sms_private.sms_deliveries",
        );
        assert.equal(remaining.rows[0].count, 2);
      },
    );
  } finally {
    await db.close();
  }
}
assert.deepEqual(
  catalogs[0],
  catalogs[1],
  "migration and fresh-schema SMS RPC definitions, settings and ACL must match",
);
console.log(
  `\nPASS: ${checks} SMS database checks plus fresh/upgrade RPC equivalence; isolated single-connection PGlite only. Real PostgreSQL lock contention, PostgREST timeout hoisting and live Auth remain unverified.`,
);
