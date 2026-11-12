/** Runs real PostgreSQL/RLS/PLpgSQL in an isolated, in-memory PGlite instance.
 * Never connects to Supabase or uses a cloud credential.
 * node scripts/db-security.mjs
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const shopA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shopB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const productA = 'aaaaaaaa-0000-4000-8000-000000000001';
const productB = 'bbbbbbbb-0000-4000-8000-000000000001';
const saleA = 'aaaaaaaa-0000-4000-8000-000000000002';
const saleB = 'bbbbbbbb-0000-4000-8000-000000000002';
const requestA = 'aaaaaaaa-0000-4000-8000-000000000003';
const requestB = 'bbbbbbbb-0000-4000-8000-000000000003';
const expenseA = 'aaaaaaaa-0000-4000-8000-000000000004';
const expenseB = 'bbbbbbbb-0000-4000-8000-000000000004';
let tests = 0;
let today;
let tomorrow;
let pendingMigrationUrls = [];

async function asUser(user, task, role = 'authenticated') {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await db.exec(`set local role ${role}`);
    const value = await task();
    await db.exec('commit'); // Deferred constraints are deliberately tested here.
    return value;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

async function test(label, task) {
  await task();
  tests += 1;
  console.log(`ok ${tests} - ${label}`);
}

async function denied(user, sql, params = [], expected = ['42501', '23503', '23514', '23505', '22023', '40001', 'P0002', '22P02', '22003']) {
  await assert.rejects(
    asUser(user, () => db.query(sql, params)),
    (error) => {
      assert.ok(expected.includes(error.code), `${error.code}: ${error.message}`);
      return true;
    },
  );
}

function item(productId = productA, quantity = 2, unitPriceCents = 350, unitCostCents = 200) {
  return {
    productId,
    name: '原价薯片',
    category: '零食',
    quantity,
    unitPriceCents,
    unitCostCents,
  };
}

function millsItem(productId, quantity = 1, unitCostMills = 445, unitPriceCents = 350) {
  return {
    productId,
    name: '三位成本测试商品',
    category: '零食',
    quantity,
    unitPriceCents,
    unitCostMills,
  };
}

function save(id, requestId, items, { date = today, extra = 100, note = '配送费', version = null } = {}) {
  return db.query('select public.save_sale($1::uuid,$2::date,$3::bigint,$4::text,$5::jsonb,$6::integer,$7::uuid) as sale', [id, date, extra, note, JSON.stringify(items), version, requestId]);
}

const freshId = () => crypto.randomUUID();

try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable security invoker as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
  `);
  await db.exec('grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;');
  await db.query('insert into auth.users(id) values ($1),($2)', [A, B]);
  if (process.argv.includes('--schema')) {
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  } else {
    // Exercise the real upgrade path as well as the optional fresh-schema path.
    const migrationsDirectory = new URL('../supabase/migrations/', import.meta.url);
    const migrationFiles = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
    const [initialMigration, ...upgradeMigrations] = migrationFiles;
    await db.exec(await readFile(new URL(initialMigration, migrationsDirectory), 'utf8'));
    pendingMigrationUrls = upgradeMigrations.map((name) => new URL(name, migrationsDirectory));
  }
  const dates = await db.query("select (clock_timestamp() at time zone 'Asia/Shanghai')::date::text as today, ((clock_timestamp() at time zone 'Asia/Shanghai')::date + 1)::text as tomorrow");
  ({ today, tomorrow } = dates.rows[0]);

  await test('all five tables enable RLS', async () => {
    const result = await db.query("select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relname in ('shops','products','sales','sale_items','expenses') and relrowsecurity");
    assert.equal(result.rows[0].n, 5);
  });
  await test('all application functions use SECURITY INVOKER', async () => {
    const result = await db.query("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef");
    assert.deepEqual(result.rows, []);
  });
  await test('PUBLIC and anon cannot execute any business function', async () => {
    const result = await db.query(`
      select p.proname from pg_proc p
      where p.pronamespace = 'public'::regnamespace and (
        has_function_privilege('anon', p.oid, 'execute')
        or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
      )`);
    assert.deepEqual(result.rows, []);
  });
  await test('authenticated can execute only intended RPC functions', async () => {
    const result = await db.query("select proname from pg_proc where pronamespace='public'::regnamespace and has_function_privilege('authenticated',oid,'execute') order by proname");
    assert.deepEqual(
      result.rows.map((row) => row.proname),
      process.argv.includes('--schema') ? ['count_inventory', 'receive_inventory', 'save_sale', 'void_sale'] : ['save_sale', 'void_sale'],
    );
  });

  for (const [user, shop, product, sale, request, expense] of [
    [A, shopA, productA, saleA, requestA, expenseA],
    [B, shopB, productB, saleB, requestB, expenseB],
  ]) {
    await asUser(user, async () => {
      await db.query('insert into public.shops(id,owner_id,name) values ($1,$2,$3)', [shop, user, `店铺 ${user[0]}`]);
      await db.query('insert into public.products(id,shop_id,name,category,purchase_unit_cost_cents,sale_unit_price_cents) values ($1,$2,$3,$4,200,350)', [product, shop, '原价薯片', '零食']);
      await save(sale, request, [item(product)]);
      await db.query("insert into public.expenses(id,shop_id,category,amount_cents,note) values ($1,$2,'packaging',50,'纸袋')", [expense, shop]);
    });
  }

  for (const table of ['shops', 'products', 'sales', 'sale_items', 'expenses']) {
    await test(`${table}: owner sees only own row`, async () => {
      const result = await asUser(A, () => db.query(`select count(*)::int as n from public.${table}`));
      assert.equal(result.rows[0].n, 1);
    });
    await test(`${table}: B cannot read A's row`, async () => {
      const predicate = table === 'shops' ? 'id' : 'shop_id';
      const result = await asUser(B, () => db.query(`select * from public.${table} where ${predicate} = $1`, [shopA]));
      assert.deepEqual(result.rows, []);
    });
    await test(`${table}: B update of A returns zero rows`, async () => {
      const predicate = table === 'shops' ? 'id' : 'shop_id';
      const result = await asUser(B, () => db.query(`update public.${table} set updated_at = now() where ${predicate} = $1 returning id`, [shopA]));
      assert.deepEqual(result.rows, []);
    });
    await test(`${table}: unauthenticated role has no table grant`, async () => {
      await assert.rejects(
        asUser('', () => db.query(`select * from public.${table}`), 'anon'),
        { code: '42501' },
      );
    });
  }

  await test('A cannot create a shop owned by B', () => denied(A, "insert into public.shops(owner_id,name) values ($1,'伪造')", [B], ['42501']));
  await test('one account cannot create a second shop', () => denied(A, "insert into public.shops(owner_id,name) values ($1,'第二家')", [A], ['23505']));
  await test('shop owner cannot be reassigned', () => denied(A, 'update public.shops set owner_id = $1 where id = $2', [B, shopA]));
  await test('shop id cannot be reassigned', () => denied(A, 'update public.shops set id = $1 where id = $2', [freshId(), shopA]));
  await test('cross-shop product insert is rejected', () => denied(A, "insert into public.products(shop_id,name,purchase_unit_cost_cents,sale_unit_price_cents) values ($1,'越权',1,1)", [shopB], ['42501']));
  await test('product shop_id is immutable', () => denied(A, 'update public.products set shop_id = $1 where id = $2', [shopB, productA]));
  await test('product id is immutable', () => denied(A, 'update public.products set id = $1 where id = $2', [freshId(), productA]));
  await test('cross-shop expense insert is rejected', () => denied(A, "insert into public.expenses(shop_id,category,amount_cents) values ($1,'other',1)", [shopB], ['42501']));
  await test('expense shop_id is immutable', () => denied(A, 'update public.expenses set shop_id = $1 where id = $2', [shopB, expenseA]));
  await test('cross-shop sales insert is rejected', () => denied(A, 'insert into public.sales(shop_id,request_id) values ($1,$2)', [shopB, freshId()], ['42501']));
  await test('sales shop_id is immutable', () => denied(A, 'update public.sales set shop_id = $1,version=version+1 where id = $2', [shopB, saleA]));
  await test('sales request identity is immutable', () => denied(A, 'update public.sales set request_id = $1,version=version+1 where id = $2', [freshId(), saleA]));
  await test('sales creation fingerprint is immutable', () => denied(A, "update public.sales set request_payload='{}',version=version+1 where id=$1", [saleA]));
  await test('cross-shop product reference is rejected', () => denied(A, 'update public.sale_items set product_id = $1 where sale_id = $2', [productB, saleA], ['23503']));
  await test('cross-shop header reference is rejected', () =>
    denied(
      A,
      "insert into public.sale_items(shop_id,sale_id,product_id,line_number,product_name_snapshot,category_snapshot,quantity,unit_sale_price_cents,unit_cost_cents) values ($1,$2,$3,2,'伪造','零食',1,1,1)",
      [shopA, saleB, productA],
      ['23503'],
    ));
  await test('sale_items shop_id is immutable', () => denied(A, 'update public.sale_items set shop_id = $1 where sale_id = $2', [shopB, saleA]));
  await test('sale_items id is immutable', () => denied(A, 'update public.sale_items set id = $1 where sale_id = $2', [freshId(), saleA]));
  await test('B cannot delete A sale_items', async () => {
    const result = await asUser(B, () => db.query('delete from public.sale_items where sale_id=$1 returning id', [saleA]));
    assert.deepEqual(result.rows, []);
  });

  for (const table of ['shops', 'products', 'sales', 'expenses']) {
    await test(`${table}: physical delete denied even to owner`, () => denied(A, `delete from public.${table}`, [], ['42501']));
  }
  await test('direct API header-only sale fails at COMMIT', () => denied(A, 'insert into public.sales(shop_id,request_id) values ($1,$2)', [shopA, freshId()], ['23514']));
  await test('deleting last item fails at COMMIT and restores original item', async () => {
    await denied(A, 'delete from public.sale_items where sale_id=$1', [saleA], ['23514']);
    const result = await asUser(A, () => db.query('select count(*)::int as n from public.sale_items where sale_id=$1', [saleA]));
    assert.equal(result.rows[0].n, 1);
  });
  await test('zero expense rejected', () => denied(A, "insert into public.expenses(shop_id,category,amount_cents) values ($1,'other',0)", [shopA], ['23514']));
  await test('excessive expense rejected', () => denied(A, "insert into public.expenses(shop_id,category,amount_cents) values ($1,'other',1000000000001)", [shopA], ['23514']));
  await test('unknown expense category rejected', () => denied(A, "insert into public.expenses(shop_id,category,amount_cents) values ($1,'purchase',1)", [shopA], ['23514']));
  await test('excessive current unit price rejected', () => denied(A, 'update public.products set sale_unit_price_cents=100000001 where id=$1', [productA], ['23514']));
  await test('zero sale quantity rejected', () => denied(A, 'update public.sale_items set quantity=0 where sale_id=$1', [saleA], ['23514']));
  await test('excessive sale quantity rejected', () => denied(A, 'update public.sale_items set quantity=100001 where sale_id=$1', [saleA], ['23514']));
  await test('excessive item revenue fails deferred total check', () => denied(A, 'update public.sale_items set quantity=100000,unit_sale_price_cents=100000000 where sale_id=$1', [saleA], ['23514']));
  await test('excessive item cost fails deferred total check', () => denied(A, 'update public.sale_items set quantity=100000,unit_cost_cents=100000000 where sale_id=$1', [saleA], ['23514']));
  await test('header extra income and item revenue share total limit', () => denied(A, 'update public.sales set extra_income_cents=1000000000000,version=version+1 where id=$1', [saleA], ['23514']));
  await test('future expense date rejected on INSERT', () => denied(A, "insert into public.expenses(shop_id,business_date,category,amount_cents) values ($1,$2,'other',1)", [shopA, tomorrow], ['23514']));
  await test('future expense date rejected on UPDATE', () => denied(A, 'update public.expenses set business_date=$1 where id=$2', [tomorrow, expenseA], ['23514']));
  await test('future sales date rejected on direct INSERT before incomplete-header check', () => denied(A, 'insert into public.sales(shop_id,business_date,request_id) values ($1,$2,$3)', [shopA, tomorrow, freshId()], ['23514']));
  await test('future sales date rejected on direct UPDATE', () => denied(A, 'update public.sales set business_date=$1,version=version+1 where id=$2', [tomorrow, saleA], ['23514']));
  await test('future sales date rejected through creation RPC', async () => {
    await assert.rejects(
      asUser(A, () => save(freshId(), freshId(), [item()], { date: tomorrow })),
      { code: '23514' },
    );
  });
  await test('future sales date rejected through editing RPC without changing version', async () => {
    await assert.rejects(
      asUser(A, () => save(saleA, requestA, [item()], { date: tomorrow, version: 1 })),
      { code: '23514' },
    );
    const result = await asUser(A, () => db.query('select version from public.sales where id=$1', [saleA]));
    assert.equal(result.rows[0].version, 1);
  });

  const directSale = freshId();
  const directRequest = freshId();
  await test('direct item UPDATE increments parent version exactly once per transaction', async () => {
    await asUser(A, () => save(directSale, directRequest, [item()], { extra: 0 }));
    await asUser(A, async () => {
      await db.query('update public.sale_items set quantity=3 where sale_id=$1', [directSale]);
      await db.query('update public.sale_items set quantity=4 where sale_id=$1', [directSale]);
    });
    const result = await asUser(A, () => db.query('select version from public.sales where id=$1', [directSale]));
    assert.equal(result.rows[0].version, 2);
  });
  await test('direct item change makes previously opened RPC edit stale', async () => {
    await assert.rejects(
      asUser(A, () => save(directSale, directRequest, [item()], { version: 1, extra: 0 })),
      { code: '40001' },
    );
  });
  await test('caller cannot forge internal transaction stamp without incrementing version', () => denied(A, 'update public.sales set version_transaction_id=pg_current_xact_id() where id=$1', [directSale], ['40001']));
  await test('direct item INSERT and DELETE each invalidate parent version', async () => {
    await asUser(A, () =>
      db.query("insert into public.sale_items(shop_id,sale_id,product_id,line_number,product_name_snapshot,category_snapshot,quantity,unit_sale_price_cents,unit_cost_cents) values ($1,$2,$3,2,'薯片','零食',1,350,200)", [
        shopA,
        directSale,
        productA,
      ]),
    );
    const inserted = await asUser(A, () => db.query('select version from public.sales where id=$1', [directSale]));
    assert.equal(inserted.rows[0].version, 3);
    await asUser(A, () => db.query('delete from public.sale_items where sale_id=$1 and line_number=2', [directSale]));
    const deleted = await asUser(A, () => db.query('select version from public.sales where id=$1', [directSale]));
    assert.equal(deleted.rows[0].version, 4);
    await asUser(A, () => db.query('select public.void_sale($1,4)', [directSale]));
  });

  await test('same creation request is idempotent', async () => {
    const retry = await asUser(A, () => save(saleA, requestA, [item()]));
    assert.equal(retry.rows[0].sale.id, saleA);
    const count = await asUser(A, () => db.query('select count(*)::int as n from public.sales'));
    assert.equal(count.rows[0].n, 2);
  });
  await test('same request with altered payload is rejected', async () => {
    await assert.rejects(
      asUser(A, () => save(saleA, requestA, [item(productA, 3)])),
      { code: '23505' },
    );
  });
  await test('same request with different id is rejected', async () => {
    await assert.rejects(
      asUser(A, () => save(freshId(), requestA, [item()])),
      { code: '23505' },
    );
  });
  await test('multi-line invalid submission rolls back header and prior valid item', async () => {
    const id = freshId();
    await assert.rejects(
      asUser(A, () => save(id, freshId(), [item(), item(productB)])),
      { code: '23503' },
    );
    const result = await asUser(A, () => db.query('select id from public.sales where id=$1 union all select id from public.sale_items where sale_id=$1', [id]));
    assert.deepEqual(result.rows, []);
  });
  await test('RPC disallows empty sale', async () => {
    await assert.rejects(
      asUser(A, () => save(freshId(), freshId(), [])),
      { code: '22023' },
    );
  });
  await test('RPC disallows fractional quantity rather than rounding', async () => {
    await assert.rejects(
      asUser(A, () => save(freshId(), freshId(), [item(productA, 1.5)])),
      { code: '22023' },
    );
  });
  await test('RPC rejects unknown product with no residual header', async () => {
    await assert.rejects(
      asUser(A, () => save(freshId(), freshId(), [item(freshId())])),
      { code: '23503' },
    );
  });
  await test('B cannot edit A sale through RPC', async () => {
    await assert.rejects(
      asUser(B, () => save(saleA, requestA, [item(productB)], { version: 1 })),
      { code: 'P0002' },
    );
  });
  await test('B cannot void A sale through RPC', () => denied(B, 'select public.void_sale($1,1)', [saleA], ['P0002']));
  await test('anon cannot call either RPC', async () => {
    await assert.rejects(
      asUser('', () => save(freshId(), freshId(), [item()]), 'anon'),
      { code: '42501' },
    );
    await assert.rejects(
      asUser('', () => db.query('select public.void_sale($1,1)', [saleA]), 'anon'),
      { code: '42501' },
    );
  });
  await test('product price/name changes preserve exact historical snapshots', async () => {
    await asUser(A, () => db.query("update public.products set name='新名称',purchase_unit_cost_cents=999,sale_unit_price_cents=1888 where id=$1", [productA]));
    const result = await asUser(A, () => db.query('select product_name_snapshot,unit_sale_price_cents::text as price,unit_cost_cents::text as cost from public.sale_items where sale_id=$1', [saleA]));
    assert.deepEqual(result.rows[0], {
      product_name_snapshot: '原价薯片',
      price: '350',
      cost: '200',
    });
  });
  await test('edit atomically increments version', async () => {
    const result = await asUser(A, () => save(saleA, requestA, [item(productA, 3)], { version: 1 }));
    assert.equal(result.rows[0].sale.version, 2);
  });
  await test('stale version cannot overwrite newer edit', async () => {
    await assert.rejects(
      asUser(A, () => save(saleA, requestA, [item()], { version: 1 })),
      { code: '40001' },
    );
    const result = await asUser(A, () => db.query('select quantity from public.sale_items where sale_id=$1', [saleA]));
    assert.equal(result.rows[0].quantity, 3);
  });
  await test('inactive product cannot enter a new sale', async () => {
    await asUser(A, () => db.query('update public.products set deleted_at=now() where id=$1', [productA]));
    await assert.rejects(
      asUser(A, () => save(freshId(), freshId(), [item()])),
      { code: '23514' },
    );
  });
  await test('existing inactive historical line remains editable with its snapshots', async () => {
    const result = await asUser(A, () => save(saleA, requestA, [item(productA, 4)], { version: 2 }));
    assert.equal(result.rows[0].sale.version, 3);
  });
  await test('inactive product cannot be introduced as another line', async () => {
    await assert.rejects(
      asUser(A, () => save(saleA, requestA, [item(), item()], { version: 3 })),
      { code: '23514' },
    );
  });
  await test('failed edit leaves version and all original items unchanged', async () => {
    const result = await asUser(A, () => db.query('select s.version,i.quantity from public.sales s join public.sale_items i on i.sale_id=s.id where s.id=$1', [saleA]));
    assert.deepEqual(result.rows, [{ version: 3, quantity: 4 }]);
  });
  await test('void checks version and removes sale from active statistics', async () => {
    await denied(A, 'select public.void_sale($1,2)', [saleA], ['40001']);
    const result = await asUser(A, () => db.query('select public.void_sale($1,3) as sale', [saleA]));
    assert.equal(result.rows[0].sale.version, 4);
    assert.ok(result.rows[0].sale.voided_at);
    const active = await asUser(A, () => db.query('select count(*)::int as n from public.sales where voided_at is null'));
    assert.equal(active.rows[0].n, 0);
  });
  await test('voided sale cannot be silently restored or its history changed', async () => {
    await denied(A, 'update public.sales set voided_at=null,version=version+1 where id=$1', [saleA], ['23514']);
    await denied(A, 'update public.sale_items set quantity=1 where sale_id=$1', [saleA], ['23514']);
    await denied(A, 'delete from public.sale_items where sale_id=$1', [saleA], ['23514']);
  });
  await test('B data is unchanged after every attack and A edit', async () => {
    const result = await asUser(B, () => db.query('select s.version,i.quantity,i.unit_sale_price_cents::text as price from public.sales s join public.sale_items i on i.sale_id=s.id where s.id=$1', [saleB]));
    assert.deepEqual(result.rows, [{ version: 1, quantity: 2, price: '350' }]);
  });
  await test('incremental upgrade preserves existing records and intended function privileges', async () => {
    const tables = ['shops', 'products', 'sales', 'sale_items', 'expenses'];
    const before = [];
    for (const table of tables) before.push((await db.query(`select to_jsonb(t) as row from public.${table} t order by id`)).rows);
    for (const migrationUrl of pendingMigrationUrls) await db.exec(await readFile(migrationUrl, 'utf8'));
    for (let index = 0; index < tables.length; index += 1) {
      const after = await db.query(`select to_jsonb(t) - 'purchase_unit_cost_mills' - 'unit_cost_mills' - 'occurred_at' - 'inventory_recorded_at' - 'inventory_quantity' as row from public.${tables[index]} t order by id`);
      // Ignore only additive precision columns; every old value stays identical,
      // including voided history, versions, request payloads and updated_at.
      before[index] = before[index].map(({ row }) => {
        const { purchase_unit_cost_mills, unit_cost_mills, occurred_at, inventory_recorded_at, inventory_quantity, ...legacy } = row;
        return { row: legacy };
      });
      assert.deepEqual(after.rows, before[index]);
    }
    assert.equal((await db.query('select count(*)::int as n from public.products where purchase_unit_cost_mills <> purchase_unit_cost_cents * 10')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from public.sale_items where unit_cost_mills <> unit_cost_cents * 10')).rows[0].n, 0);
    assert.ok((await db.query('select count(*)::int as n from public.sales where voided_at is not null')).rows[0].n > 0);
    assert.equal((await db.query("select count(*)::int as n from pg_trigger where tgname in ('products_immutable','sale_items_guard','sale_items_immutable') and tgenabled = 'O'")).rows[0].n, 3);
    const rpc = await db.query("select proname from pg_proc where pronamespace='public'::regnamespace and has_function_privilege('authenticated',oid,'execute') order by proname");
    assert.deepEqual(
      rpc.rows.map((row) => row.proname),
      ['count_inventory', 'receive_inventory', 'save_sale', 'void_sale'],
    );
    const unsafe = await db.query("select proname from pg_proc where pronamespace='public'::regnamespace and (prosecdef or has_function_privilege('anon',oid,'execute'))");
    assert.deepEqual(unsafe.rows, []);
  });
  await test('a pre-upgrade raw cents creation request can still retry without altering stored history', async () => {
    const before = await db.query('select to_jsonb(s) as row from public.sales s where id=$1', [saleB]);
    const result = await asUser(B, () => save(saleB, requestB, [item(productB)]));
    assert.equal(result.rows[0].sale.version, 1);
    assert.deepEqual((await db.query('select to_jsonb(s) as row from public.sales s where id=$1', [saleB])).rows, before.rows);
    assert.equal((await db.query('select count(*)::int as n from public.sale_items where sale_id=$1', [saleB])).rows[0].n, 1);
  });

  const reorderSale = freshId();
  const reorderRequest = freshId();
  const reorderProductA = freshId();
  const reorderProductB = freshId();
  const unrelatedInactiveProduct = freshId();
  let originalInactiveItemId;
  await asUser(A, async () => {
    for (const productId of [reorderProductA, reorderProductB, unrelatedInactiveProduct]) {
      await db.query("insert into public.products(id,shop_id,name,category,purchase_unit_cost_cents,sale_unit_price_cents) values ($1,$2,'顺序回归商品','零食',200,350)", [productId, shopA]);
    }
    await save(reorderSale, reorderRequest, [item(reorderProductA), item(reorderProductB)], { extra: 0 });
    const original = await db.query('select id from public.sale_items where sale_id=$1 and product_id=$2', [reorderSale, reorderProductB]);
    originalInactiveItemId = original.rows[0].id;
    await db.query('update public.products set deleted_at=now() where id=any($1::uuid[])', [[reorderProductB, unrelatedInactiveProduct]]);
  });
  await test('removing an earlier line preserves and compacts the later inactive product', async () => {
    const result = await asUser(A, () =>
      save(reorderSale, reorderRequest, [item(reorderProductB)], {
        extra: 0,
        version: 1,
      }),
    );
    assert.equal(result.rows[0].sale.version, 2);
    const lines = await asUser(A, () => db.query('select id,product_id,line_number,unit_sale_price_cents::text as price,unit_cost_cents::text as cost from public.sale_items where sale_id=$1 order by line_number', [reorderSale]));
    assert.deepEqual(lines.rows, [
      {
        id: originalInactiveItemId,
        product_id: reorderProductB,
        line_number: 1,
        price: '350',
        cost: '200',
      },
    ]);
  });
  await test('retained inactive item remains editable after compaction', async () => {
    const result = await asUser(A, () =>
      save(reorderSale, reorderRequest, [item(reorderProductB, 3, 375, 210)], {
        extra: 0,
        version: 2,
      }),
    );
    assert.equal(result.rows[0].sale.version, 3);
    const line = await asUser(A, () => db.query('select id,quantity,unit_sale_price_cents::text as price,unit_cost_cents::text as cost from public.sale_items where sale_id=$1', [reorderSale]));
    assert.deepEqual(line.rows, [{ id: originalInactiveItemId, quantity: 3, price: '375', cost: '210' }]);
  });
  await test('adding an active earlier line preserves the later inactive item identity', async () => {
    const result = await asUser(A, () => save(reorderSale, reorderRequest, [item(reorderProductA), item(reorderProductB, 3, 375, 210)], { extra: 0, version: 3 }));
    assert.equal(result.rows[0].sale.version, 4);
    const line = await asUser(A, () => db.query('select id,line_number from public.sale_items where sale_id=$1 and product_id=$2', [reorderSale, reorderProductB]));
    assert.deepEqual(line.rows, [{ id: originalInactiveItemId, line_number: 2 }]);
  });
  await test('swapping existing positions preserves both row identities', async () => {
    const previous = await asUser(A, () => db.query('select id,product_id from public.sale_items where sale_id=$1 order by product_id', [reorderSale]));
    const result = await asUser(A, () => save(reorderSale, reorderRequest, [item(reorderProductB, 3, 375, 210), item(reorderProductA)], { extra: 0, version: 4 }));
    assert.equal(result.rows[0].sale.version, 5);
    const current = await asUser(A, () => db.query('select id,product_id from public.sale_items where sale_id=$1 order by product_id', [reorderSale]));
    assert.deepEqual(current.rows, previous.rows);
  });
  await test('reorder cannot introduce an unrelated inactive product', async () => {
    await assert.rejects(
      asUser(A, () => save(reorderSale, reorderRequest, [item(reorderProductB), item(unrelatedInactiveProduct)], { extra: 0, version: 5 })),
      { code: '23514' },
    );
  });
  await test('reorder cannot duplicate a retained inactive product', async () => {
    await assert.rejects(
      asUser(A, () => save(reorderSale, reorderRequest, [item(reorderProductB), item(reorderProductB)], { extra: 0, version: 5 })),
      { code: '23514' },
    );
  });
  await test('direct update cannot replace an active item with a historical inactive product', () =>
    denied(A, 'update public.sale_items set product_id=$1 where sale_id=$2 and product_id=$3', [reorderProductB, reorderSale, reorderProductA], ['23514']));
  await test('failed reorders roll back header version, row ids and corrected snapshots', async () => {
    const rows = await asUser(A, () =>
      db.query(
        'select s.version,i.id,i.product_id,i.line_number,i.quantity,i.unit_sale_price_cents::text as price,i.unit_cost_cents::text as cost from public.sales s join public.sale_items i on i.sale_id=s.id where s.id=$1 order by i.line_number',
        [reorderSale],
      ),
    );
    assert.equal(rows.rows[0].version, 5);
    assert.deepEqual(rows.rows[0], {
      version: 5,
      id: originalInactiveItemId,
      product_id: reorderProductB,
      line_number: 1,
      quantity: 3,
      price: '375',
      cost: '210',
    });
    assert.equal(rows.rows.length, 2);
  });
  await test('duplicate final positions fail at COMMIT and roll back the parent version', async () => {
    await denied(A, 'update public.sale_items set line_number=1 where sale_id=$1 and product_id=$2', [reorderSale, reorderProductA], ['23505']);
    const result = await asUser(A, () => db.query('select version from public.sales where id=$1', [reorderSale]));
    assert.equal(result.rows[0].version, 5);
  });
  await test('removing inactive history prevents reintroducing it on a later edit', async () => {
    const result = await asUser(A, () =>
      save(reorderSale, reorderRequest, [item(reorderProductA)], {
        extra: 0,
        version: 5,
      }),
    );
    assert.equal(result.rows[0].sale.version, 6);
    await assert.rejects(
      asUser(A, () => save(reorderSale, reorderRequest, [item(reorderProductB), item(reorderProductA)], { extra: 0, version: 6 })),
      { code: '23514' },
    );
  });

  const precise614 = freshId();
  const precise445 = freshId();
  const another445 = freshId();
  const ordinaryCost = freshId();
  await test('new products accept mills-only costs and derive rounded legacy cents', async () => {
    await asUser(A, async () => {
      for (const [id, mills] of [
        [precise614, 614],
        [precise445, 445],
        [another445, 445],
        [ordinaryCost, 400],
      ]) {
        await db.query("insert into public.products(id,shop_id,name,category,purchase_unit_cost_mills,sale_unit_price_cents) values($1,$2,'三位成本测试商品','零食',$3,350)", [id, shopA, mills]);
      }
    });
    const result = await asUser(A, () => db.query('select purchase_unit_cost_mills::text as mills,purchase_unit_cost_cents::text as cents from public.products where id=$1', [precise614]));
    assert.deepEqual(result.rows, [{ mills: '614', cents: '61' }]);
    const half = await asUser(A, () => db.query('select purchase_unit_cost_mills::text as mills,purchase_unit_cost_cents::text as cents from public.products where id=$1', [precise445]));
    assert.deepEqual(half.rows, [{ mills: '445', cents: '45' }]);
  });
  await test('legacy product cost edit cannot erase fractional precision', async () => {
    const before = await db.query('select to_jsonb(p) as row from public.products p where id=$1', [precise614]);
    await denied(A, 'update public.products set purchase_unit_cost_cents=62 where id=$1', [precise614], ['22023']);
    assert.deepEqual((await db.query('select to_jsonb(p) as row from public.products p where id=$1', [precise614])).rows, before.rows);
    await asUser(A, () => db.query("update public.products set name='只改名称',purchase_unit_cost_cents=61 where id=$1", [precise614]));
    assert.equal((await db.query('select purchase_unit_cost_mills::text as mills from public.products where id=$1', [precise614])).rows[0].mills, '614');
  });
  await test('new product edits synchronize legacy cents and ordinary legacy edits remain usable', async () => {
    await asUser(A, () => db.query('update public.products set purchase_unit_cost_mills=410 where id=$1', [ordinaryCost]));
    assert.equal((await db.query('select purchase_unit_cost_cents::text as cents from public.products where id=$1', [ordinaryCost])).rows[0].cents, '41');
    await asUser(A, () => db.query('update public.products set purchase_unit_cost_cents=42 where id=$1', [ordinaryCost]));
    assert.equal((await db.query('select purchase_unit_cost_mills::text as mills from public.products where id=$1', [ordinaryCost])).rows[0].mills, '420');
  });
  await test('mills product costs reject null, negative and over-limit updates', async () => {
    await denied(A, 'update public.products set purchase_unit_cost_mills=null where id=$1', [precise614], ['22023']);
    for (const amount of [-1, 1000000001]) await denied(A, 'update public.products set purchase_unit_cost_mills=$1 where id=$2', [amount, precise614], ['23514']);
  });

  const costSaleOne = freshId();
  const costRequestOne = freshId();
  const costSaleTwo = freshId();
  const costSaleSplit = freshId();
  async function exactLineCost(id) {
    return (await asUser(A, () => db.query('select sum(floor((quantity::numeric*unit_cost_mills+5)/10))::text as cents from public.sale_items where sale_id=$1', [id]))).rows[0].cents;
  }
  await test('445 mills x 1 rounds the line cost to 45 fen, with exact snapshot retained', async () => {
    const result = await asUser(A, () => save(costSaleOne, costRequestOne, [millsItem(precise445)], { extra: 0 }));
    assert.equal(result.rows[0].sale.version, 1);
    assert.equal(await exactLineCost(costSaleOne), '45');
    const snapshot = await db.query('select unit_cost_mills::text as mills,unit_cost_cents::text as cents from public.sale_items where sale_id=$1', [costSaleOne]);
    assert.deepEqual(snapshot.rows, [{ mills: '445', cents: '45' }]);
  });
  await test('445 mills x 2 rounds after multiplying quantity, giving 89 fen', async () => {
    await asUser(A, () => save(costSaleTwo, freshId(), [millsItem(precise445, 2)], { extra: 0 }));
    assert.equal(await exactLineCost(costSaleTwo), '89');
  });
  await test('two separate 445-mill lines each x 1 cost 90 fen, not aggregate-rounded 89', async () => {
    await asUser(A, () => save(costSaleSplit, freshId(), [millsItem(precise445), millsItem(another445)], { extra: 0 }));
    assert.equal(await exactLineCost(costSaleSplit), '90');
  });
  await test('new precision RPC create retries are idempotent but changed raw costs are rejected', async () => {
    const result = await asUser(A, () => save(costSaleOne, costRequestOne, [millsItem(precise445)], { extra: 0 }));
    assert.equal(result.rows[0].sale.version, 1);
    await assert.rejects(
      asUser(A, () =>
        save(costSaleOne, costRequestOne, [millsItem(precise445, 1, 446)], {
          extra: 0,
        }),
      ),
      { code: '23505' },
    );
    assert.equal((await db.query('select count(*)::int as n from public.sale_items where sale_id=$1', [costSaleOne])).rows[0].n, 1);
  });
  await test('legacy RPC cannot create a new sale using a fractional-cost product', async () => {
    const id = freshId();
    await assert.rejects(
      asUser(A, () => save(id, freshId(), [item(precise614, 1, 350, 61)], { extra: 0 })),
      { code: '22023' },
    );
    assert.equal((await db.query('select count(*)::int as n from public.sales where id=$1', [id])).rows[0].n, 0);
  });
  await test('legacy RPC cannot remove fractional historical lines by submitting only ordinary products', async () => {
    const before = await db.query('select to_jsonb(s) as row from public.sales s where id=$1', [costSaleSplit]);
    await assert.rejects(
      asUser(A, () => save(costSaleSplit, before.rows[0].row.request_id, [item(ordinaryCost, 1, 350, 42)], { extra: 0, version: 1 })),
      { code: '22023' },
    );
    assert.deepEqual((await db.query('select to_jsonb(s) as row from public.sales s where id=$1', [costSaleSplit])).rows, before.rows);
    assert.equal((await db.query('select count(*)::int as n from public.sale_items where sale_id=$1', [costSaleSplit])).rows[0].n, 2);
  });
  await test('new RPC edits preserve precise snapshots and immutable creation payload, bumping version once', async () => {
    const before = await db.query('select request_payload from public.sales where id=$1', [costSaleOne]);
    const result = await asUser(A, () =>
      save(costSaleOne, costRequestOne, [millsItem(precise445, 2, 614)], {
        extra: 0,
        version: 1,
      }),
    );
    assert.equal(result.rows[0].sale.version, 2);
    assert.equal(await exactLineCost(costSaleOne), '123');
    assert.deepEqual((await db.query('select request_payload from public.sales where id=$1', [costSaleOne])).rows, before.rows);
    await assert.rejects(
      asUser(A, () =>
        save(costSaleOne, costRequestOne, [millsItem(precise445)], {
          extra: 0,
          version: 1,
        }),
      ),
      { code: '40001' },
    );
  });
  await test('direct legacy cost updates cannot overwrite fractional sale history or bump its version on failure', async () => {
    await denied(A, 'update public.sale_items set unit_cost_cents=62 where sale_id=$1', [costSaleOne], ['22023']);
    await denied(A, 'update public.sale_items set unit_cost_mills=null where sale_id=$1', [costSaleOne], ['22023']);
    assert.equal((await db.query('select version from public.sales where id=$1', [costSaleOne])).rows[0].version, 2);
    assert.equal((await db.query('select unit_cost_mills::text as mills from public.sale_items where sale_id=$1', [costSaleOne])).rows[0].mills, '614');
  });
  await test('direct legacy inserts cannot bypass fractional product guards', async () => {
    await denied(
      A,
      "insert into public.sale_items(shop_id,sale_id,product_id,line_number,product_name_snapshot,category_snapshot,quantity,unit_sale_price_cents,unit_cost_cents) values($1,$2,$3,2,'测试','零食',1,350,45)",
      [shopA, costSaleOne, precise445],
      ['22023'],
    );
    assert.equal((await db.query('select version from public.sales where id=$1', [costSaleOne])).rows[0].version, 2);
  });
  await test('ordinary legacy RPC remains compatible and retry identity is not silently normalized', async () => {
    const id = freshId();
    const request = freshId();
    await asUser(A, () => save(id, request, [item(ordinaryCost, 1, 350, 42)], { extra: 0 }));
    const result = await asUser(A, () => save(id, request, [item(ordinaryCost, 1, 350, 42)], { extra: 0 }));
    assert.equal(result.rows[0].sale.version, 1);
    await assert.rejects(
      asUser(A, () => save(id, request, [{ ...millsItem(ordinaryCost, 1, 420), name: '原价薯片' }], { extra: 0 })),
      { code: '23505' },
    );
    assert.equal((await db.query('select unit_cost_mills::text as mills from public.sale_items where sale_id=$1', [id])).rows[0].mills, '420');
  });
  await test('successful legacy creation retries still return after current product gains fractional precision', async () => {
    const product = freshId();
    const id = freshId();
    const request = freshId();
    await asUser(A, async () => {
      await db.query("insert into public.products(id,shop_id,name,category,purchase_unit_cost_cents,sale_unit_price_cents) values($1,$2,'旧请求重试测试','零食',40,350)", [product, shopA]);
      await save(id, request, [item(product, 1, 350, 40)], { extra: 0 });
      await db.query('update public.products set purchase_unit_cost_mills=445 where id=$1', [product]);
    });
    const beforeHeader = await db.query('select to_jsonb(s) as row from public.sales s where id=$1', [id]);
    const beforeItems = await db.query('select to_jsonb(i) as row from public.sale_items i where sale_id=$1 order by id', [id]);
    const result = await asUser(A, () => save(id, request, [item(product, 1, 350, 40)], { extra: 0 }));
    assert.equal(result.rows[0].sale.id, id);
    assert.equal(result.rows[0].sale.version, 1);
    assert.deepEqual((await db.query('select to_jsonb(s) as row from public.sales s where id=$1', [id])).rows, beforeHeader.rows);
    assert.deepEqual((await db.query('select to_jsonb(i) as row from public.sale_items i where sale_id=$1 order by id', [id])).rows, beforeItems.rows);
    await assert.rejects(
      asUser(A, () => save(id, request, [item(product, 2, 350, 40)], { extra: 0 })),
      { code: '23505' },
    );
    await assert.rejects(
      asUser(A, () => save(freshId(), request, [item(product, 1, 350, 40)], { extra: 0 })),
      { code: '23505' },
    );
    await assert.rejects(
      asUser(A, () => save(freshId(), freshId(), [item(product, 1, 350, 40)], { extra: 0 })),
      { code: '22023' },
    );
    assert.deepEqual((await db.query('select to_jsonb(s) as row from public.sales s where id=$1', [id])).rows, beforeHeader.rows);
  });
  await test('mixed or conflicting cost units, decimal mills and excessive costs are rejected atomically', async () => {
    for (const entries of [[millsItem(precise445), item(ordinaryCost)], [{ ...millsItem(precise445), unitCostCents: 45 }], [millsItem(precise445, 1, 445.5)], [millsItem(precise445, 1, -1)], [millsItem(precise445, 1, 1000000001)]]) {
      const id = freshId();
      await assert.rejects(
        asUser(A, () => save(id, freshId(), entries, { extra: 0 })),
        (error) => ['22023', '23514'].includes(error.code),
      );
      assert.equal((await db.query('select count(*)::int as n from public.sales where id=$1', [id])).rows[0].n, 0);
    }
  });
  await test('new mill-based deferred total constraint keeps the old final-fen cost limit', async () => {
    const allowed = freshId();
    await asUser(A, () =>
      save(allowed, freshId(), [millsItem(precise445, 10000, 1000000000, 0)], {
        extra: 0,
      }),
    );
    assert.equal(await exactLineCost(allowed), '1000000000000');
    for (const entries of [[millsItem(precise445, 100000, 1000000000, 0)], [millsItem(precise445, 10000, 1000000000, 0), millsItem(another445, 1, 445, 0)]])
      await assert.rejects(
        asUser(A, () => save(freshId(), freshId(), entries, { extra: 0 })),
        { code: '23514' },
      );
  });
  await test('new cost columns remain tenant-isolated through direct APIs and RPC', async () => {
    assert.deepEqual((await asUser(B, () => db.query('select purchase_unit_cost_mills from public.products where id=$1', [precise614]))).rows, []);
    assert.deepEqual((await asUser(B, () => db.query('select unit_cost_mills from public.sale_items where sale_id=$1', [costSaleOne]))).rows, []);
    assert.deepEqual((await asUser(B, () => db.query('update public.products set purchase_unit_cost_mills=1 where id=$1 returning id', [precise614]))).rows, []);
    await assert.rejects(
      asUser(B, () =>
        save(costSaleOne, costRequestOne, [millsItem(precise445)], {
          extra: 0,
          version: 2,
        }),
      ),
      { code: 'P0002' },
    );
    await assert.rejects(
      asUser(B, () => save(freshId(), freshId(), [millsItem(precise445)], { extra: 0 })),
      { code: '23503' },
    );
  });
  await test('precision helper remains trigger-only and no RLS policy or guard was disabled', async () => {
    assert.equal((await db.query("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace and relname in ('shops','products','sales','sale_items','expenses') and relrowsecurity")).rows[0].n, 5);
    assert.equal((await db.query("select count(*)::int as n from pg_proc where pronamespace='public'::regnamespace and (prosecdef or has_function_privilege('anon',oid,'execute'))")).rows[0].n, 0);
    assert.equal((await db.query("select has_function_privilege('authenticated','public.sync_product_cost_mills()','execute') as allowed")).rows[0].allowed, false);
    assert.equal((await db.query("select count(*)::int as n from pg_trigger where tgname in ('products_cost_precision','products_immutable','sale_items_guard','sale_items_immutable') and tgenabled='O'")).rows[0].n, 4);
  });

  const invP = freshId();
  const invQ = freshId();
  const invUnknown = freshId();
  const beforeCountSale = freshId();
  const beforeCountRequest = freshId();
  const invCountId = freshId();
  const invReceiptId = freshId();
  const invSaleId = freshId();
  const invSaleRequest = freshId();
  const carriedSaleId = freshId();
  const carriedSaleRequest = freshId();
  const stock = (productId = invP) => asUser(A, async () => (await db.query('select quantity::text as quantity from public.inventory_levels where product_id=$1', [productId])).rows[0]?.quantity ?? null);
  const countStock = (productId, quantity, requestId, expected) => db.query('select public.count_inventory($1::uuid,$2::integer,$3::uuid,$4::bigint) as count', [productId, quantity, requestId, expected]);
  const receiveStock = (productId, quantity, id, cost = 445, date = today) => db.query("select public.receive_inventory($1::uuid,$2::uuid,$3::date,$4::integer,$5::bigint,'新进货') as receipt", [id, productId, date, quantity, cost]);
  const savePaid = (id, requestId, quantity, occurredAt, date = today) =>
    db.query("select public.save_sale($1::uuid,$2::date,0::bigint,''::text,$3::jsonb,null::integer,$4::uuid,$5::timestamptz) as sale", [id, date, JSON.stringify([millsItem(invP, quantity)]), requestId, occurredAt]);
  await test('untracked stock stays unknown and existing/new sales never invent an opening balance', async () => {
    await asUser(A, async () => {
      for (const product of [invP, invQ, invUnknown]) await db.query("insert into public.products(id,shop_id,name,category,purchase_unit_cost_mills,sale_unit_price_cents) values($1,$2,'库存测试','零食',445,350)", [product, shopA]);
      await save(beforeCountSale, beforeCountRequest, [millsItem(invP, 4)], {
        extra: 0,
      });
      await save(freshId(), freshId(), [millsItem(invUnknown, 99)], {
        extra: 0,
      });
    });
    assert.equal(await stock(), null);
    assert.equal(await stock(invUnknown), null);
  });
  await test('initial count creates exactly the counted balance, ignoring all earlier sales', async () => {
    await asUser(A, () => countStock(invP, 20, invCountId, null));
    assert.equal(await stock(), '20');
    const row = (await asUser(A, () => db.query('select initialized_at=counted_at as first from public.inventory_levels where product_id=$1', [invP]))).rows[0];
    assert.equal(row.first, true);
  });
  await test('count request retries are idempotent and changed contents/stale stock are rejected', async () => {
    await asUser(A, () => countStock(invP, 20, invCountId, null));
    assert.equal(await stock(), '20');
    await assert.rejects(
      asUser(A, () => countStock(invP, 21, invCountId, null)),
      { code: '23505' },
    );
    await assert.rejects(
      asUser(A, () => countStock(invP, 21, freshId(), null)),
      { code: '40001' },
    );
    assert.equal((await db.query('select count(*)::int as n from public.inventory_counts where product_id=$1', [invP])).rows[0].n, 1);
  });
  await test('receipt adds stock exactly once and retains 445 mills without changing product/history costs', async () => {
    const before = (await db.query('select to_jsonb(p) as row from public.products p where id=$1', [invP])).rows;
    const result = await asUser(A, () => receiveStock(invP, 10, invReceiptId, 614));
    await asUser(A, () => receiveStock(invP, 10, invReceiptId, 614));
    assert.equal(result.rows[0].receipt.unit_cost_mills, 614);
    assert.equal(await stock(), '30');
    await assert.rejects(
      asUser(A, () => receiveStock(invP, 11, invReceiptId, 614)),
      { code: '23505' },
    );
    assert.deepEqual((await db.query('select to_jsonb(p) as row from public.products p where id=$1', [invP])).rows, before);
    assert.equal((await db.query('select unit_cost_mills::text as mills from public.sale_items where sale_id=$1', [beforeCountSale])).rows[0].mills, '445');
  });
  await test('new sale deducts stock once, edit adjusts only its delta, and void restores its deduction', async () => {
    await asUser(A, () => save(invSaleId, invSaleRequest, [millsItem(invP, 4)], { extra: 0 }));
    assert.equal(await stock(), '26');
    await asUser(A, () => save(invSaleId, invSaleRequest, [millsItem(invP, 4)], { extra: 0 }));
    assert.equal(await stock(), '26');
    await asUser(A, () =>
      save(invSaleId, invSaleRequest, [millsItem(invP, 6)], {
        extra: 0,
        version: 1,
      }),
    );
    assert.equal(await stock(), '24');
    await asUser(A, () => db.query('select public.void_sale($1,2)', [invSaleId]));
    assert.equal(await stock(), '30');
  });
  await test('editing and voiding a sale recorded before first count never changes current stock', async () => {
    await asUser(A, () =>
      save(beforeCountSale, beforeCountRequest, [millsItem(invP, 8)], {
        extra: 0,
        version: 1,
      }),
    );
    assert.equal(await stock(), '30');
    await asUser(A, () => db.query('select public.void_sale($1,2)', [beforeCountSale]));
    assert.equal(await stock(), '30');
  });
  await test('recount replaces stock baseline and excludes previous receipts and sales', async () => {
    await asUser(A, () =>
      save(carriedSaleId, carriedSaleRequest, [millsItem(invP, 3)], {
        extra: 0,
      }),
    );
    assert.equal(await stock(), '27');
    await asUser(A, () => countStock(invP, 18, freshId(), 27));
    assert.equal(await stock(), '18');
    await asUser(A, () =>
      save(carriedSaleId, carriedSaleRequest, [millsItem(invP, 7)], {
        extra: 0,
        version: 1,
      }),
    );
    assert.equal(await stock(), '18');
    await asUser(A, () => db.query('select public.void_sale($1,2)', [carriedSaleId]));
    assert.equal(await stock(), '18');
  });
  await test('retrying old count and receipt requests after recount never resets or adds to the latest balance', async () => {
    await asUser(A, () => countStock(invP, 20, invCountId, null));
    await asUser(A, () => receiveStock(invP, 10, invReceiptId, 614));
    assert.equal(await stock(), '18');
    const order = (await db.query('select c.initialized_at > s.inventory_recorded_at as ordered from public.inventory_counts c cross join public.sales s where c.product_id=$1 and s.id=$2 order by c.initialized_at desc limit 1', [invP, carriedSaleId])).rows[0];
    assert.equal(order.ordered, true);
  });
  await test('late same-day import uses actual payment time before count, not import time or note', async () => {
    const paid = (await db.query("select ($1::date::timestamp at time zone 'Asia/Shanghai')::text as paid", [today])).rows[0].paid;
    const id = freshId(),
      request = freshId();
    await asUser(A, () => savePaid(id, request, 100, paid));
    await asUser(A, () => savePaid(id, request, 100, paid));
    assert.equal(await stock(), '18');
    assert.equal((await db.query('select inventory_quantity from public.sale_items where sale_id=$1', [id])).rows[0].inventory_quantity, 0);
  });
  const postCountSale = freshId(),
    postCountRequest = freshId();
  await test('payment after count deducts stock and retry with a different paid time is rejected', async () => {
    const paid = (await db.query('select clock_timestamp()::text as paid')).rows[0].paid;
    await asUser(A, () => savePaid(postCountSale, postCountRequest, 4, paid));
    assert.equal(await stock(), '14');
    await assert.rejects(
      asUser(A, () => savePaid(postCountSale, postCountRequest, 4, `${today}T00:00:00+08:00`)),
      { code: '23505' },
    );
  });
  await test('insufficient inventory rejects new/edited/multi-line sales atomically with unchanged versions', async () => {
    const id = freshId();
    await assert.rejects(
      asUser(A, () => save(id, freshId(), [millsItem(invP, 15)], { extra: 0 })),
      { code: '23514' },
    );
    assert.equal((await db.query('select count(*)::int as n from public.sales where id=$1', [id])).rows[0].n, 0);
    await assert.rejects(
      asUser(A, () =>
        save(postCountSale, postCountRequest, [millsItem(invP, 19)], {
          extra: 0,
          version: 1,
        }),
      ),
      { code: '23514' },
    );
    assert.equal((await db.query('select version from public.sales where id=$1', [postCountSale])).rows[0].version, 1);
    assert.equal(await stock(), '14');
  });
  await test('direct API cannot forge deducted quantity, stock timestamps or stale counts', async () => {
    await asUser(A, () => db.query('update public.sale_items set inventory_quantity=0 where sale_id=$1', [postCountSale]));
    assert.equal(await stock(), '14');
    await denied(A, 'update public.sales set inventory_recorded_at=null,version=version+1 where id=$1', [postCountSale], ['23514']);
    await denied(A, 'insert into public.inventory_counts(id,shop_id,product_id,initial_quantity,request_id) values($1,$2,$3,99,$1)', [freshId(), shopA, invP], ['40001']);
    await denied(A, 'update public.inventory_counts set initial_quantity=99 where product_id=$1', [invP], ['42501']);
    await denied(A, 'delete from public.inventory_receipts where product_id=$1', [invP], ['42501']);
  });
  await test('receipt requires known stock and rejects zero/negative quantities and pre-count dates', async () => {
    await assert.rejects(
      asUser(A, () => receiveStock(invUnknown, 1, freshId())),
      { code: '23514' },
    );
    for (const quantity of [0, -1])
      await assert.rejects(
        asUser(A, () => receiveStock(invP, quantity, freshId())),
        { code: '23514' },
      );
    const past = (await db.query('select ($1::date-1)::text as day', [today])).rows[0].day;
    await assert.rejects(
      asUser(A, () => receiveStock(invP, 1, freshId(), 445, past)),
      { code: '23514' },
    );
    assert.equal(await stock(), '14');
  });
  await test('sale paid time must match Shanghai business day and cannot be in the future', async () => {
    for (const paid of [`${tomorrow}T00:00:00+08:00`, `${today}T23:59:59+08:00`]) {
      const id = freshId();
      await assert.rejects(
        asUser(A, () => savePaid(id, freshId(), 1, paid)),
        { code: '22023' },
      );
      assert.equal((await db.query('select count(*)::int as n from public.sales where id=$1', [id])).rows[0].n, 0);
    }
  });
  await test('stock RLS and invoker RPC enforce ownership and reject cross-shop product references', async () => {
    for (const table of ['inventory_counts', 'inventory_receipts', 'inventory_levels']) {
      assert.deepEqual((await asUser(B, () => db.query(`select * from public.${table} where shop_id=$1`, [shopA]))).rows, []);
      await assert.rejects(
        asUser(A, () => db.query(`select * from public.${table}`), 'anon'),
        { code: '42501' },
      );
    }
  });

  await test('other owners cannot count/receive a foreign product or mutate immutable inventory logs', async () => {
    await assert.rejects(
      asUser(B, () => countStock(invP, 10, freshId(), null)),
      { code: '23503' },
    );
    await assert.rejects(
      asUser(B, () => receiveStock(invP, 1, freshId())),
      { code: '23503' },
    );
    await denied(A, 'insert into public.inventory_receipts(id,shop_id,product_id,business_date,quantity,unit_cost_mills) values($1,$2,$3,$4,1,445)', [freshId(), shopA, productB, today], ['23503']);
    assert.equal(await stock(), '14');
  });
  await test('recount zero is valid, older void cannot replenish it, and two sales cannot oversell the remaining balance', async () => {
    await asUser(A, () => countStock(invP, 0, freshId(), 14));
    await asUser(A, () => db.query('select public.void_sale($1,2)', [postCountSale]));
    assert.equal(await stock(), '0');
    await asUser(A, () => receiveStock(invP, 2, freshId()));
    await assert.rejects(
      asUser(A, () => countStock(invP, 9, freshId(), 0)),
      { code: '40001' },
    );
    await asUser(A, () => save(freshId(), freshId(), [millsItem(invP, 2)], { extra: 0 }));
    await assert.rejects(
      asUser(A, () => save(freshId(), freshId(), [millsItem(invP, 1)], { extra: 0 })),
      { code: '23514' },
    );
    assert.equal(await stock(), '0');
  });
  await test('multiple product lines and duplicate lines share one atomic stock constraint', async () => {
    await asUser(A, () => countStock(invQ, 2, freshId(), null));
    for (const items of [
      [millsItem(invUnknown, 1), millsItem(invQ, 3)],
      [millsItem(invQ, 2), millsItem(invQ, 1)],
    ]) {
      const id = freshId();
      await assert.rejects(
        asUser(A, () => save(id, freshId(), items, { extra: 0 })),
        { code: '23514' },
      );
      assert.equal((await db.query('select count(*)::int as n from public.sales where id=$1', [id])).rows[0].n, 0);
      assert.equal(await stock(invQ), '2');
    }
    const id = freshId(),
      request = freshId();
    await asUser(A, () => save(id, request, [millsItem(invQ, 1), millsItem(invQ, 1)], { extra: 0 }));
    assert.equal(await stock(invQ), '0');
    await asUser(A, () => save(id, request, [millsItem(invQ, 2)], { extra: 0, version: 1 }));
    assert.equal(await stock(invQ), '0');
    await asUser(A, () => db.query('select public.void_sale($1,2)', [id]));
    assert.equal(await stock(invQ), '2');
  });
  await test('sales-only receipt can book zero-stock goods without changing any stock balance', async () => {
    const before = await stock(invQ);
    const id = freshId(), request = freshId();
    const params = [id, today, 0, '明确仅补记销售', JSON.stringify([millsItem(invQ, 100)]), null, request];
    const create = () => db.query('select public.save_sale($1::uuid,$2::date,$3::bigint,$4::text,$5::jsonb,$6::integer,$7::uuid,null,true) as sale', params);
    const saved = await asUser(A, create);
    assert.equal(saved.rows[0].sale.request_payload.salesOnly, true);
    assert.equal(await stock(invQ), before);
    assert.equal((await db.query('select inventory_quantity from public.sale_items where sale_id=$1', [id])).rows[0].inventory_quantity, 0);
    await asUser(A, create);
    assert.equal((await db.query('select count(*)::int as n from public.sales where id=$1', [id])).rows[0].n, 1);
    await denied(A, 'select public.save_sale($1::uuid,$2::date,0,$3::text,$4::jsonb,null,$5::uuid)', [id, today, params[3], params[4], request], ['23505']);
    await denied(A, "update public.sales set request_payload=request_payload-'salesOnly',version=version+1 where id=$1", [id], ['23514']);
    await asUser(A, () => save(id, request, [millsItem(invQ, 101)], { extra: 0, version: 1 }));
    assert.equal(await stock(invQ), before);
    assert.equal((await db.query('select inventory_quantity from public.sale_items where sale_id=$1', [id])).rows[0].inventory_quantity, 0);
    await asUser(A, () => db.query('select public.void_sale($1,2)', [id]));
    assert.equal(await stock(invQ), before);
  });
  await test('sales-only import still enforces ownership and valid parameters', async () => {
    const args = [freshId(), today, JSON.stringify([millsItem(productB, 1)]), freshId()];
    await denied(A, "select public.save_sale($1::uuid,$2::date,0,'',$3::jsonb,null,$4::uuid,null,true)", args, ['23503']);
    await denied(A, "select public.save_sale($1::uuid,$2::date,0,'',$3::jsonb,null,$4::uuid,null,null)", [freshId(), today, JSON.stringify([millsItem(invQ, 1)]), freshId()], ['22023']);
  });
  await test('new stock tables use RLS, safe view and only intended invoker RPC grants', async () => {
    assert.equal((await db.query("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace and relname in ('inventory_counts','inventory_receipts') and relrowsecurity")).rows[0].n, 2);
    assert.equal((await db.query("select reloptions from pg_class where oid='public.inventory_levels'::regclass")).rows[0].reloptions.includes('security_invoker=true'), true);
    assert.equal((await db.query("select count(*)::int as n from pg_proc where pronamespace='public'::regnamespace and (prosecdef or has_function_privilege('anon',oid,'execute'))")).rows[0].n, 0);
    const rpc = (await db.query("select proname from pg_proc where pronamespace='public'::regnamespace and has_function_privilege('authenticated',oid,'execute') order by proname")).rows.map((r) => r.proname);
    assert.deepEqual(rpc, ['count_inventory', 'receive_inventory', 'save_sale', 'void_sale']);
  });
  console.log(`\nPASS: ${tests} database assertions (${process.argv.includes('--schema') ? 'fresh schema' : 'ordered migrations'}); isolated PGlite only, no cloud deployment or live Auth claims verified.`);
} finally {
  await db.close();
}
