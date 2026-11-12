/**
 * Production acceptance using two already authenticated, ordinary user clients.
 * Does not load configuration, create Auth users, send messages, or clean up data.
 * Every business read/write is scoped to UUIDs allocated by this run.
 *
 * onManifest receives a credential-free copy BEFORE writes and after discoveries.
 * A thrown error also carries .manifest and .results so partial runs can be cleaned.
 * planned/probe UUIDs must be checked during cleanup even after a failed assertion:
 * an unexpectedly successful attack can have committed a QA row.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLES = ["shops", "products", "sales", "sale_items", "expenses"];
const copy = (value) => JSON.parse(JSON.stringify(value));
const safeCode = (value) =>
  typeof value === "string" && /^[A-Z0-9_]{1,40}$/.test(value)
    ? value
    : "UNCLASSIFIED";
const safeStatus = (value) =>
  Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;

function failure(label, code = "ASSERTION_FAILED", status) {
  const error = new Error(`${label}: ${safeCode(code)}`);
  error.name = "LiveIsolationError";
  error.code = safeCode(code);
  error.status = safeStatus(status);
  return error;
}

function requireValue(condition, code = "ASSERTION_FAILED") {
  if (!condition) throw failure("assertion", code);
}

function successful(response) {
  if (response?.error)
    throw failure("request", response.error.code, response.status);
  requireValue(Array.isArray(response?.data), "EXPECTED_ARRAY");
  return response.data;
}

function single(response) {
  const rows = successful(response);
  requireValue(rows.length === 1, "EXPECTED_ONE_ROW");
  return rows[0];
}

function denied(response, codes) {
  requireValue(Boolean(response?.error), "EXPECTED_DENIAL");
  requireValue(codes.includes(response.error.code), "UNEXPECTED_DB_CODE");
  return { code: response.error.code, status: response.status };
}

function empty(response) {
  requireValue(successful(response).length === 0, "EXPECTED_ZERO_ROWS");
  return { code: "NO_ROWS", status: response.status };
}

function cents(value) {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  requireValue(Number.isSafeInteger(parsed) && parsed >= 0, "INVALID_AMOUNT");
  return parsed;
}

function equal(actual, expected) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    // Never retain assertion diffs, SDK responses, credentials, or error stacks.
    throw failure("assertion", "UNEXPECTED_DATA");
  }
}

function sorted(rows) {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * @param {{accounts: Array<{label: 'A'|'B', client: object, userId: string}>,
 * tag: string, onResult?: Function, onManifest?: Function}} options
 */
export async function runLiveIsolation({ accounts, tag, onResult, onManifest }) {
  const results = [];
  const manifest = {
    version: 1,
    tag: typeof tag === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(tag) ? tag : null,
    startedAt: new Date().toISOString(),
    completed: false,
    accounts: [],
    probes: [],
  };

  async function publishManifest() {
    if (!onManifest) return;
    try {
      await onManifest(copy(manifest));
    } catch {
      throw failure("manifest callback", "CALLBACK_FAILED");
    }
  }

  async function test(label, work) {
    let detail;
    try {
      detail = await work();
    } catch (cause) {
      const result = {
        label, passed: false,
        code: safeCode(cause?.code), status: safeStatus(cause?.status),
      };
      results.push(result);
      if (onResult) {
        try { await onResult(copy(result)); } catch { /* preserve original failure */ }
      }
      throw failure(label, result.code, result.status);
    }
    const result = {
      label, passed: true,
      code: safeCode(detail?.code ?? "OK"), status: safeStatus(detail?.status),
    };
    results.push(result);
    if (onResult) {
      try { await onResult(copy(result)); }
      catch { throw failure(label, "CALLBACK_FAILED"); }
    }
  }

  try {
    requireValue(typeof tag === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(tag), "INVALID_QA_TAG");
    requireValue(Array.isArray(accounts) && accounts.length === 2, "REQUIRE_TWO_ACCOUNTS");
    requireValue(accounts[0]?.label === "A" && accounts[1]?.label === "B", "INVALID_ACCOUNT_LABELS");
    requireValue(accounts.every((account) => UUID.test(account.userId ?? "")), "INVALID_USER_ID");
    requireValue(accounts[0].userId !== accounts[1].userId, "REQUIRE_DISTINCT_ACCOUNTS");
    requireValue(accounts.every((account) =>
      typeof account.client?.from === "function" &&
      typeof account.client?.rpc === "function" &&
      typeof account.client?.auth?.getUser === "function"), "INVALID_USER_CLIENT");

    const day = todayInShanghai();
    const fixtures = accounts.map((account, index) => {
      const fixture = {
        label: account.label,
        userId: account.userId,
        client: account.client,
        shopId: randomUUID(), productId: randomUUID(), saleId: randomUUID(),
        expenseId: randomUUID(), requestId: randomUUID(), itemId: null,
        shopName: `qa-${tag}-${account.label}-shop`,
        productName: `qa-${tag}-${account.label}-product`,
        note: `qa-${tag}-${account.label}`,
        initial: index === 0
          ? { quantity: 2, price: 350, cost: 200, extra: 100, expense: 50 }
          : { quantity: 4, price: 500, cost: 250, extra: 50, expense: 80 },
        corrected: index === 0
          ? { quantity: 3, price: 375, cost: 210, extra: 125, expense: 75 }
          : { quantity: 5, price: 525, cost: 260, extra: 75, expense: 95 },
        probes: {},
      };
      fixture.manifest = {
        label: fixture.label, userId: fixture.userId, shopId: fixture.shopId,
        productIds: [fixture.productId], saleIds: [fixture.saleId],
        saleItemIds: [], expenseIds: [fixture.expenseId], requestIds: [fixture.requestId],
        confirmed: { shop: false, productIds: [], saleIds: [], saleItemIds: [], expenseIds: [] },
        pendingSaleItemDiscovery: [],
      };
      manifest.accounts.push(fixture.manifest);
      return fixture;
    });

    function probe(fixture, name, table, shopId, extra = {}) {
      const entry = { label: `${fixture.label} ${name}`, actor: fixture.label,
        table, id: randomUUID(), shopId, ...extra };
      fixture.probes[name] = entry;
      manifest.probes.push(entry);
      return entry;
    }
    for (const [fixture, other] of [[fixtures[0], fixtures[1]], [fixtures[1], fixtures[0]]]) {
      probe(fixture, "foreignOwner", "shops", null, { ownerId: other.userId });
      probe(fixture, "foreignProduct", "products", other.shopId);
      probe(fixture, "foreignExpense", "expenses", other.shopId);
      probe(fixture, "foreignSale", "sales", other.shopId, { requestId: randomUUID() });
      probe(fixture, "foreignItem", "sale_items", other.shopId, { saleId: other.saleId });
      probe(fixture, "foreignProductReference", "sale_items", fixture.shopId, { saleId: fixture.saleId });
      probe(fixture, "foreignSaleReference", "sale_items", fixture.shopId, { saleId: other.saleId });
      probe(fixture, "mixedRpc", "sales", fixture.shopId, { requestId: randomUUID() });
    }
    // This snapshot already contains every client-assigned write ID, including attacks.
    await publishManifest();

    const item = (fixture, values, productId = fixture.productId) => ({
      productId, name: fixture.productName, category: "QA验收",
      quantity: values.quantity, unitPriceCents: values.price, unitCostCents: values.cost,
    });
    const salePayload = (fixture, values, version = null) => ({
      p_id: fixture.saleId, p_business_date: day, p_extra_income_cents: values.extra,
      p_note: fixture.note, p_items: [item(fixture, values)],
      p_expected_version: version, p_request_id: fixture.requestId,
    });
    const rowId = (fixture, table) => ({
      shops: fixture.shopId, products: fixture.productId, sales: fixture.saleId,
      sale_items: fixture.itemId, expenses: fixture.expenseId,
    })[table];

    async function snapshot(fixture) {
      const rows = {};
      for (const table of TABLES) {
        const response = await fixture.client.from(table).select("*").eq("id", rowId(fixture, table));
        rows[table] = single(response);
        requireValue(rows[table].id === rowId(fixture, table), "WRONG_RECORD");
        requireValue(table === "shops"
          ? rows[table].owner_id === fixture.userId
          : rows[table].shop_id === fixture.shopId, "WRONG_OWNER");
      }
      return rows;
    }

    async function verifyMath(fixture, rows, values) {
      const line = rows.sale_items;
      equal(line.product_id, fixture.productId);
      equal(line.product_name_snapshot, fixture.productName);
      equal(line.category_snapshot, "QA验收");
      equal(cents(line.quantity), values.quantity);
      equal(cents(line.unit_sale_price_cents), values.price);
      equal(cents(line.unit_cost_cents), values.cost);
      equal(cents(rows.sales.extra_income_cents), values.extra);
      equal(cents(rows.expenses.amount_cents), values.expense);
      equal(rows.sales.voided_at, null);
      equal(rows.expenses.deleted_at, null);
      const revenue = cents(line.quantity) * cents(line.unit_sale_price_cents)
        + cents(rows.sales.extra_income_cents);
      const cost = cents(line.quantity) * cents(line.unit_cost_cents);
      const gross = revenue - cost;
      const profit = gross - cents(rows.expenses.amount_cents);
      const expectedRevenue = values.quantity * values.price + values.extra;
      const expectedCost = values.quantity * values.cost;
      equal({ revenue, cost, gross, profit }, {
        revenue: expectedRevenue, cost: expectedCost,
        gross: expectedRevenue - expectedCost,
        profit: expectedRevenue - expectedCost - values.expense,
      });
      const rate = profit / revenue * 100;
      requireValue(Number.isFinite(rate), "INVALID_PROFIT_RATE");
      // Explicit known-cent totals also catch mistaken cents/yuan conversions.
      const totals = fixture.label === "A"
        ? (values === fixture.initial ? [800, 400, 350] : [1250, 630, 545])
        : (values === fixture.initial ? [2050, 1000, 970] : [2700, 1300, 1305]);
      equal([revenue, cost, profit], totals);
      requireValue(Math.abs(rate - totals[2] / totals[0] * 100) < 1e-10,
        "UNEXPECTED_PROFIT_RATE");
    }

    for (const fixture of fixtures) {
      await test(`${fixture.label} verify ordinary Auth identity`, async () => {
        const response = await fixture.client.auth.getUser();
        requireValue(!response.error, "AUTH_USER_FAILED");
        equal(response.data?.user?.id, fixture.userId);
        equal(response.data?.user?.role, "authenticated");
        requireValue(response.data?.user?.is_anonymous !== true, "ANONYMOUS_USER");
      });
      await test(`${fixture.label} create own QA shop`, async () => {
        const response = await fixture.client.from("shops").insert({
          id: fixture.shopId, owner_id: fixture.userId, name: fixture.shopName,
          currency: "CNY", timezone: "Asia/Shanghai",
        }).select("id,owner_id,name");
        const row = single(response);
        equal(row, { id: fixture.shopId, owner_id: fixture.userId, name: fixture.shopName });
        fixture.manifest.confirmed.shop = true;
        await publishManifest();
        return { status: response.status };
      });
      await test(`${fixture.label} create own QA product`, async () => {
        const response = await fixture.client.from("products").insert({
          id: fixture.productId, shop_id: fixture.shopId, name: fixture.productName,
          category: "QA验收", purchase_unit_cost_cents: fixture.initial.cost,
          sale_unit_price_cents: fixture.initial.price,
        }).select("id,shop_id");
        equal(single(response), { id: fixture.productId, shop_id: fixture.shopId });
        fixture.manifest.confirmed.productIds.push(fixture.productId);
        await publishManifest();
        return { status: response.status };
      });
      await test(`${fixture.label} create atomic QA sale`, async () => {
        fixture.manifest.pendingSaleItemDiscovery.push(fixture.saleId);
        await publishManifest();
        const response = await fixture.client.rpc("save_sale", salePayload(fixture, fixture.initial));
        if (response.error) throw failure("sale creation", response.error.code, response.status);
        equal(response.data?.id, fixture.saleId);
        equal(response.data?.shop_id, fixture.shopId);
        equal(response.data?.version, 1);
        fixture.manifest.confirmed.saleIds.push(fixture.saleId);
        await publishManifest();
        const lines = successful(await fixture.client.from("sale_items").select("id,shop_id,sale_id")
          .eq("shop_id", fixture.shopId).eq("sale_id", fixture.saleId));
        requireValue(lines.length === 1 && UUID.test(lines[0].id), "EXPECTED_ONE_QA_ITEM");
        equal(lines[0].shop_id, fixture.shopId);
        equal(lines[0].sale_id, fixture.saleId);
        fixture.itemId = lines[0].id;
        fixture.manifest.saleItemIds.push(fixture.itemId);
        fixture.manifest.confirmed.saleItemIds.push(fixture.itemId);
        fixture.manifest.pendingSaleItemDiscovery = [];
        await publishManifest();
        return { status: response.status };
      });
      await test(`${fixture.label} create own QA expense`, async () => {
        const response = await fixture.client.from("expenses").insert({
          id: fixture.expenseId, shop_id: fixture.shopId, business_date: day,
          category: "packaging", amount_cents: fixture.initial.expense, note: fixture.note,
        }).select("id,shop_id");
        equal(single(response), { id: fixture.expenseId, shop_id: fixture.shopId });
        fixture.manifest.confirmed.expenseIds.push(fixture.expenseId);
        await publishManifest();
        return { status: response.status };
      });
      await test(`${fixture.label} read own records and verify profit`, async () => {
        fixture.beforeAttacks = await snapshot(fixture);
        await verifyMath(fixture, fixture.beforeAttacks, fixture.initial);
      });
    }

    for (const [fixture, other] of [[fixtures[0], fixtures[1]], [fixtures[1], fixtures[0]]]) {
      for (const table of TABLES) {
        await test(`${fixture.label} ${table} read isolation`, async () => {
          const response = await fixture.client.from(table).select("id")
            .in("id", [rowId(fixture, table), rowId(other, table)]);
          equal(successful(response), [{ id: rowId(fixture, table) }]);
          return { status: response.status };
        });
        await test(`${fixture.label} ${table} cross update blocked`, async () => {
          const patch = {
            shops: { name: `qa-${tag}-blocked` },
            products: { name: `qa-${tag}-blocked` },
            sales: { note: `qa-${tag}-blocked`, version: 2 },
            sale_items: { quantity: 99 },
            expenses: { amount_cents: 9999, note: `qa-${tag}-blocked` },
          }[table];
          return empty(await fixture.client.from(table).update(patch)
            .eq("id", rowId(other, table)).select("id"));
        });
        await test(`${fixture.label} ${table} cross delete blocked`, async () => {
          const response = await fixture.client.from(table).delete()
            .eq("id", rowId(other, table)).select("id");
          return table === "sale_items" ? empty(response) : denied(response, ["42501"]);
        });
      }
      await test(`${fixture.label} nested sale item read isolation`, async () => {
        const response = await fixture.client.from("sales")
          .select("id,shop_id,sale_items(id,shop_id,product_id)")
          .in("id", [fixture.saleId, other.saleId]);
        equal(successful(response), [{
          id: fixture.saleId, shop_id: fixture.shopId,
          sale_items: [{ id: fixture.itemId, shop_id: fixture.shopId, product_id: fixture.productId }],
        }]);
        return { status: response.status };
      });
      await test(`${fixture.label} forged shop owner rejected`, async () => {
        return denied(await fixture.client.from("shops").insert({
          id: fixture.probes.foreignOwner.id, owner_id: other.userId, name: `qa-${tag}-forged`,
        }).select("id"), ["42501"]);
      });
      await test(`${fixture.label} foreign product insert rejected`, async () => {
        return denied(await fixture.client.from("products").insert({
          id: fixture.probes.foreignProduct.id, shop_id: other.shopId,
          name: `qa-${tag}-foreign`, category: "QA验收",
          purchase_unit_cost_cents: 1, sale_unit_price_cents: 2,
        }).select("id"), ["42501"]);
      });
      await test(`${fixture.label} foreign expense insert rejected`, async () => {
        return denied(await fixture.client.from("expenses").insert({
          id: fixture.probes.foreignExpense.id, shop_id: other.shopId,
          business_date: day, category: "other", amount_cents: 1, note: `qa-${tag}-foreign`,
        }).select("id"), ["42501"]);
      });
      await test(`${fixture.label} foreign sale insert rejected by RLS`, async () => {
        return denied(await fixture.client.from("sales").insert({
          id: fixture.probes.foreignSale.id, shop_id: other.shopId,
          business_date: day, request_id: fixture.probes.foreignSale.requestId,
          note: `qa-${tag}-foreign`,
        }).select("id"), ["42501"]);
      });
      const directItem = (id, shopId, saleId, productId) => ({
        id, shop_id: shopId, sale_id: saleId, product_id: productId, line_number: 2,
        product_name_snapshot: `qa-${tag}-probe`, category_snapshot: "QA验收",
        quantity: 1, unit_sale_price_cents: 2, unit_cost_cents: 1,
      });
      await test(`${fixture.label} foreign item insert rejected`, async () => {
        return denied(await fixture.client.from("sale_items").insert(directItem(
          fixture.probes.foreignItem.id, other.shopId, other.saleId, other.productId,
        )).select("id"), ["42501", "23503"]);
      });
      await test(`${fixture.label} composite foreign product rejected`, async () => {
        return denied(await fixture.client.from("sale_items").insert(directItem(
          fixture.probes.foreignProductReference.id, fixture.shopId, fixture.saleId, other.productId,
        )).select("id"), ["23503"]);
      });
      await test(`${fixture.label} composite foreign sale rejected`, async () => {
        return denied(await fixture.client.from("sale_items").insert(directItem(
          fixture.probes.foreignSaleReference.id, fixture.shopId, other.saleId, fixture.productId,
        )).select("id"), ["23503"]);
      });
      await test(`${fixture.label} historical product substitution rejected`, async () => {
        return denied(await fixture.client.from("sale_items").update({ product_id: other.productId })
          .eq("id", fixture.itemId).select("id"), ["23503"]);
      });
      await test(`${fixture.label} shop owner immutable`, async () => {
        return denied(await fixture.client.from("shops").update({ owner_id: other.userId })
          .eq("id", fixture.shopId).select("id"), ["23514"]);
      });
      for (const table of TABLES.filter((table) => table !== "shops")) {
        await test(`${fixture.label} ${table} shop immutable`, async () => {
          const patch = { shop_id: other.shopId };
          if (table === "sales") patch.version = 2;
          return denied(await fixture.client.from(table).update(patch)
            .eq("id", rowId(fixture, table)).select("id"),
          table === "sale_items" ? ["23514", "23503"] : ["23514"]);
        });
      }
      await test(`${fixture.label} cross RPC sale edit rejected`, async () => {
        const payload = salePayload(fixture, fixture.initial, 1);
        payload.p_id = other.saleId;
        payload.p_request_id = other.requestId;
        return denied(await fixture.client.rpc("save_sale", payload), ["P0002"]);
      });
      await test(`${fixture.label} cross RPC sale void rejected`, async () => {
        return denied(await fixture.client.rpc("void_sale", {
          p_id: other.saleId, p_expected_version: 1,
        }), ["P0002"]);
      });
      await test(`${fixture.label} mixed-tenant RPC rolls back atomically`, async () => {
        const planned = fixture.probes.mixedRpc;
        const payload = salePayload(fixture, fixture.initial);
        payload.p_id = planned.id;
        payload.p_request_id = planned.requestId;
        payload.p_items.push(item(fixture, fixture.initial, other.productId));
        // If a regression commits this RPC, cleanup can discover its server UUIDs.
        fixture.manifest.pendingSaleItemDiscovery.push(planned.id);
        await publishManifest();
        const response = await fixture.client.rpc("save_sale", payload);
        denied(response, ["23503"]);
        empty(await fixture.client.from("sales").select("id").eq("id", planned.id));
        empty(await fixture.client.from("sale_items").select("id")
          .eq("shop_id", fixture.shopId).eq("sale_id", planned.id));
        fixture.manifest.pendingSaleItemDiscovery = [];
        await publishManifest();
        return { code: "23503", status: response.status };
      });
    }

    for (const fixture of fixtures) {
      await test(`${fixture.label} all attack attempts left QA data unchanged`, async () => {
        equal(await snapshot(fixture), fixture.beforeAttacks);
      });
    }
    for (const fixture of fixtures) {
      await test(`${fixture.label} own product price update preserves history`, async () => {
        const response = await fixture.client.from("products").update({
          name: `${fixture.productName}-edited`, purchase_unit_cost_cents: 999,
          sale_unit_price_cents: 1999,
        }).eq("shop_id", fixture.shopId).eq("id", fixture.productId).select("id");
        equal(single(response), { id: fixture.productId });
        const line = single(await fixture.client.from("sale_items").select("*")
          .eq("shop_id", fixture.shopId).eq("id", fixture.itemId));
        equal(line, fixture.beforeAttacks.sale_items);
        return { status: response.status };
      });
      await test(`${fixture.label} own sale correction is persisted atomically`, async () => {
        const response = await fixture.client.rpc("save_sale", salePayload(fixture, fixture.corrected, 1));
        if (response.error) throw failure("sale edit", response.error.code, response.status);
        equal(response.data?.id, fixture.saleId);
        equal(response.data?.version, 2);
        const lines = successful(await fixture.client.from("sale_items").select("id")
          .eq("shop_id", fixture.shopId).eq("sale_id", fixture.saleId));
        equal(lines, [{ id: fixture.itemId }]);
        return { status: response.status };
      });
      await test(`${fixture.label} own expense correction persists`, async () => {
        const response = await fixture.client.from("expenses").update({
          amount_cents: fixture.corrected.expense, note: `${fixture.note}-edited`,
        }).eq("shop_id", fixture.shopId).eq("id", fixture.expenseId).select("id");
        equal(single(response), { id: fixture.expenseId });
        return { status: response.status };
      });
      await test(`${fixture.label} corrected historical costs and profit verified`, async () => {
        fixture.final = await snapshot(fixture);
        equal(fixture.final.sales.version, 2);
        equal(cents(fixture.final.products.purchase_unit_cost_cents), 999);
        equal(cents(fixture.final.products.sale_unit_price_cents), 1999);
        await verifyMath(fixture, fixture.final, fixture.corrected);
      });
      const other = fixtures.find((candidate) => candidate !== fixture);
      await test(`${fixture.label} corrections did not alter other account`, async () => {
        equal(await snapshot(other), other.final ?? other.beforeAttacks);
      });
    }

    for (const fixture of fixtures) {
      await test(`${fixture.label} final data and failed-probe absence verified`, async () => {
        equal(await snapshot(fixture), fixture.final);
        // A failed foreign-shop insert would belong to the victim. Both real JWTs
        // inspect every planned probe UUID, without scanning unrelated tenant data.
        for (const table of TABLES) {
          const probeIds = manifest.probes.filter((entry) => entry.table === table).map((entry) => entry.id);
          if (!probeIds.length) continue;
          empty(await fixture.client.from(table).select("id").in("id", probeIds));
        }
        const ownLines = successful(await fixture.client.from("sale_items").select("id")
          .eq("shop_id", fixture.shopId).eq("sale_id", fixture.saleId));
        equal(sorted(ownLines), [{ id: fixture.itemId }]);
      });
    }
    manifest.completed = true;
    await publishManifest();
    return { manifest: copy(manifest), results: copy(results) };
  } catch (cause) {
    const error = failure("live isolation stopped", cause?.code, cause?.status);
    error.manifest = copy(manifest);
    error.results = copy(results);
    throw error;
  }
}
