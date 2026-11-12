import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countInventory,
  loadLedger,
  putProduct,
  putSale,
  receiveInventory,
} from "./cloud-repository.ts";
import { MAX_UNIT_MILLS, summarize } from "./domain.ts";

type Table =
  "products" | "sales" | "expenses" | "inventory_levels" | "inventory_receipts";
type Row = { id: string; shop_id: string; [key: string]: unknown };
type Tables = Record<Table, Row[]>;
type Read = {
  table: Table;
  selection: string;
  shopId?: unknown;
  cursor?: string;
  order?: { column: string; ascending: boolean };
  limit: number;
  page: number;
};
type Response = { data: Row[] | null; error: unknown };

const shopId = "00000000-0000-4000-8000-000000000001";
const day = "2026-10-15";
const timestamp = `${day}T00:00:00Z`;
const id = (n: number) =>
  `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => id(index + 1));

function productRow(n: number): Row {
  return {
    id: id(n),
    shop_id: shopId,
    name: `商品${n}`,
    category: "饮品",
    purchase_unit_cost_cents: 100,
    sale_unit_price_cents: 200,
    deleted_at: null,
    updated_at: timestamp,
  };
}

function saleRow(n: number): Row {
  return {
    id: id(n),
    shop_id: shopId,
    business_date: day,
    extra_income_cents: 0,
    note: "",
    version: 1,
    voided_at: null,
    created_at: timestamp,
    sale_items: [
      {
        line_number: 1,
        product_id: id(n),
        product_name_snapshot: `商品${n}`,
        category_snapshot: "饮品",
        quantity: 1,
        unit_sale_price_cents: 200,
        unit_cost_cents: 100,
      },
    ],
  };
}

function expenseRow(n: number): Row {
  return {
    id: id(n),
    shop_id: shopId,
    business_date: day,
    category: "transport",
    amount_cents: 25,
    note: "",
    deleted_at: null,
    created_at: timestamp,
  };
}

// 只实现账本读取用到的查询；测试不创建真实客户端、不读取环境变量或访问网络。
function memoryClient(
  initial: Partial<Tables> = {},
  beforeRead?: (read: Read, tables: Tables) => Response | void,
) {
  const tables: Tables = {
    products: [],
    sales: [],
    expenses: [],
    inventory_levels: [],
    inventory_receipts: [],
    ...structuredClone(initial),
  };
  const reads: Read[] = [];
  const pageCounts: Record<Table, number> = {
    products: 0,
    sales: 0,
    expenses: 0,
    inventory_levels: 0,
    inventory_receipts: 0,
  };
  const client = {
    from(table: Table) {
      assert.ok(
        [
          "products",
          "sales",
          "expenses",
          "inventory_levels",
          "inventory_receipts",
        ].includes(table),
      );
      const read: Read = { table, selection: "", limit: 0, page: 0 };
      const query = {
        select(selection: string) {
          read.selection = selection;
          return query;
        },
        eq(column: string, value: unknown) {
          assert.equal(column, "shop_id");
          read.shopId = value;
          return query;
        },
        order(column: string, options: { ascending: boolean }) {
          read.order = { column, ascending: options.ascending };
          return query;
        },
        gt(column: string, value: string) {
          assert.equal(column, "id");
          read.cursor = value;
          return query;
        },
        async limit(limit: number): Promise<Response> {
          read.limit = limit;
          read.page = ++pageCounts[table];
          reads.push(structuredClone(read));
          const override = beforeRead?.(read, tables);
          if (override)
            return {
              data: structuredClone(override.data),
              error: override.error,
            };
          assert.deepEqual(read.order, { column: "id", ascending: true });
          const rows = tables[table]
            .filter(
              (row) =>
                row.shop_id === read.shopId &&
                (read.cursor === undefined || row.id > read.cursor),
            )
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, limit);
          return { data: structuredClone(rows), error: null };
        },
      };
      return query;
    },
  };
  return { client: client as unknown as SupabaseClient, reads, tables };
}

for (const count of [0, 1, 499, 500, 501, 1000, 1001]) {
  test(`完整读取${count}条记录，500条边界不截断商品、销售和支出`, async () => {
    const numbers = Array.from({ length: count }, (_, index) => index + 1);
    const { client, reads } = memoryClient({
      products: numbers.map(productRow),
      sales: numbers.map(saleRow),
      expenses: numbers.map(expenseRow),
    });
    const ledger = await loadLedger(client, shopId);

    for (const table of ["products", "sales", "expenses"] as const) {
      assert.deepEqual(
        ledger[table].map((row) => row.id),
        ids(count),
      );
      const pages = reads.filter((read) => read.table === table);
      assert.equal(pages.length, Math.floor(count / 500) + 1);
      assert.ok(pages.every((read) => read.limit === 500));
      assert.ok(pages.every((read) => read.shopId === shopId));
      assert.deepEqual(
        pages.map((read) => read.cursor),
        pages.map((_, index) => (index === 0 ? undefined : id(index * 500))),
      );
    }
    assert.ok(
      reads
        .filter((read) => read.table === "sales")
        .every((read) => read.selection === "*,sale_items(*)"),
    );
    assert.equal(summarize(ledger, day, day).profit, count * 75);
  });
}

test("翻页时插入游标前的新销售，不重复计入历史销售，下一次刷新补入新销售", async () => {
  const { client, reads } = memoryClient(
    { sales: Array.from({ length: 501 }, (_, index) => saleRow(index + 1)) },
    (read, tables) => {
      if (read.table === "sales" && read.page === 2)
        tables.sales.push(saleRow(0));
    },
  );

  const ledger = await loadLedger(client, shopId);
  assert.deepEqual(
    ledger.sales.map((sale) => sale.id),
    ids(501),
  );
  assert.equal(new Set(ledger.sales.map((sale) => sale.id)).size, 501);
  assert.equal(summarize(ledger, day, day).profit, 50100);
  assert.equal(
    reads.filter((read) => read.table === "sales")[1].cursor,
    id(500),
  );

  const refreshed = await loadLedger(client, shopId);
  assert.deepEqual(
    refreshed.sales.map((sale) => sale.id),
    [id(0), ...ids(501)],
  );
  assert.equal(summarize(refreshed, day, day).profit, 50200);
});

test("翻页时插入游标后的新销售，本次读取包含新销售且每笔只计算一次", async () => {
  const { client } = memoryClient(
    { sales: Array.from({ length: 501 }, (_, index) => saleRow(index + 1)) },
    (read, tables) => {
      if (read.table === "sales" && read.page === 2)
        tables.sales.push(saleRow(502));
    },
  );

  const ledger = await loadLedger(client, shopId);
  assert.deepEqual(
    ledger.sales.map((sale) => sale.id),
    ids(502),
  );
  assert.equal(summarize(ledger, day, day).profit, 50200);
});

test("翻页时删除已读取的销售，不跳过剩余的稳定历史记录", async () => {
  const { client } = memoryClient(
    { sales: Array.from({ length: 501 }, (_, index) => saleRow(index + 1)) },
    (read, tables) => {
      if (read.table === "sales" && read.page === 2)
        tables.sales = tables.sales.filter((sale) => sale.id !== id(100));
    },
  );

  const ledger = await loadLedger(client, shopId);
  assert.deepEqual(
    ledger.sales.map((sale) => sale.id),
    ids(501),
  );
  assert.equal(summarize(ledger, day, day).profit, 50100);

  const refreshed = await loadLedger(client, shopId);
  assert.deepEqual(
    refreshed.sales.map((sale) => sale.id),
    ids(501).filter((saleId) => saleId !== id(100)),
  );
});

test("异常重叠页面按销售编号去重，保留同次响应的销售头和明细快照", async () => {
  const { client } = memoryClient(
    { sales: Array.from({ length: 500 }, (_, index) => saleRow(index + 1)) },
    (read) => {
      if (read.table !== "sales" || read.page !== 2) return;
      const overlapping = saleRow(500);
      overlapping.extra_income_cents = 90000;
      overlapping.sale_items = [];
      return {
        data: [overlapping, saleRow(501), saleRow(501)],
        error: null,
      };
    },
  );

  const ledger = await loadLedger(client, shopId);
  assert.deepEqual(
    ledger.sales.map((sale) => sale.id),
    ids(501),
  );
  assert.equal(ledger.sales[499].extraIncomeCents, 0);
  assert.equal(ledger.sales[499].items.length, 1);
  assert.equal(summarize(ledger, day, day).profit, 50100);
});

test("异常重复页未推进游标时整次读取失败，不无限翻页或返回部分账本", async () => {
  const repeated = Array.from({ length: 500 }, (_, index) =>
    saleRow(index + 1),
  );
  const { client, reads } = memoryClient({ sales: repeated }, (read) => {
    if (read.table === "sales" && read.page === 2)
      return { data: repeated, error: null };
    assert.ok(read.page <= 2);
  });

  await assert.rejects(loadLedger(client, shopId), /分页读取未前进/);
  assert.equal(reads.filter((read) => read.table === "sales").length, 2);
});

test("后续页数据库错误原样向上传播，不返回部分账本", async () => {
  const error = { code: "42501", message: "permission denied" };
  const { client } = memoryClient(
    { sales: Array.from({ length: 500 }, (_, index) => saleRow(index + 1)) },
    (read) => {
      if (read.table === "sales" && read.page === 2)
        return { data: null, error };
    },
  );

  await assert.rejects(loadLedger(client, shopId), (reason) => {
    assert.equal(reason, error);
    return true;
  });
});

test("销售读取一直携带明细并按行号还原顺序，排除其他店铺销售", async () => {
  const row = saleRow(1);
  const first = (row.sale_items as Record<string, unknown>[])[0];
  row.sale_items = [
    { ...first, line_number: 2, product_name_snapshot: "第二行" },
    { ...first, line_number: 1, product_name_snapshot: "第一行" },
  ];
  const foreign = { ...saleRow(2), shop_id: "another-shop" };
  const { client, reads } = memoryClient({ sales: [row, foreign] });

  const ledger = await loadLedger(client, shopId);
  assert.deepEqual(
    ledger.sales.map((sale) => sale.id),
    [id(1)],
  );
  assert.deepEqual(
    ledger.sales[0].items.map((item) => item.name),
    ["第一行", "第二行"],
  );
  assert.equal(
    reads.find((read) => read.table === "sales")?.selection,
    "*,sale_items(*)",
  );
});

test("缺少销售明细时整次读取失败", async () => {
  const row = saleRow(1);
  delete row.sale_items;
  const { client } = memoryClient({ sales: [row] });

  await assert.rejects(loadLedger(client, shopId), /销售明细加载不完整/);
});

test("缺少记录编号或无有效页面数据时拒绝部分账本", async () => {
  for (const data of [null, [{ ...saleRow(1), id: "" }]]) {
    const { client } = memoryClient({}, (read) => {
      if (read.table === "sales") return { data, error: null };
    });
    await assert.rejects(
      loadLedger(client, shopId),
      /账本加载不完整|记录缺少编号/,
    );
  }
});

test("旧整数分成本仅在厘字段缺失时等值读取，不改变原销售利润", async () => {
  const { client } = memoryClient({
    products: [productRow(1)],
    sales: [saleRow(1)],
  });
  const ledger = await loadLedger(client, shopId);
  assert.equal(ledger.products[0].costMills, 1000);
  assert.equal(ledger.sales[0].items[0].unitCostMills, 1000);
  assert.equal(summarize(ledger, day, day).grossProfit, 100);
});

test("新厘成本优先且保留第三位，售价、实收仍用分", async () => {
  const product = { ...productRow(1), purchase_unit_cost_mills: "614" };
  const sale = saleRow(1);
  const item = (sale.sale_items as Record<string, unknown>[])[0];
  item.unit_cost_mills = "445";
  const { client } = memoryClient({ products: [product], sales: [sale] });
  const ledger = await loadLedger(client, shopId);
  assert.equal(ledger.products[0].costMills, 614);
  assert.equal(ledger.products[0].priceCents, 200);
  assert.equal(ledger.sales[0].items[0].unitCostMills, 445);
  assert.equal(summarize(ledger, day, day).cost, 45);
  assert.equal(summarize(ledger, day, day).revenue, 200);
});

test("新成本字段存在但无效时拒绝加载，不能静默退回旧分字段", async () => {
  for (const value of [null, undefined, 0.5, -1, "bad", MAX_UNIT_MILLS + 1]) {
    const product = { ...productRow(1), purchase_unit_cost_mills: value };
    await assert.rejects(
      loadLedger(memoryClient({ products: [product] }).client, shopId),
    );
    const sale = saleRow(1);
    (sale.sale_items as Record<string, unknown>[])[0].unit_cost_mills = value;
    await assert.rejects(
      loadLedger(memoryClient({ sales: [sale] }).client, shopId),
    );
  }
});

test("旧成本超出厘单位安全范围时拒绝换算", async () => {
  const { client } = memoryClient({
    products: [
      { ...productRow(1), purchase_unit_cost_cents: Number.MAX_SAFE_INTEGER },
    ],
  });
  await assert.rejects(loadLedger(client, shopId), /无效单位成本/);
});

test("商品新写入只使用厘成本字段，不发送舍入后的旧成本", async () => {
  let written: Record<string, unknown> | undefined;
  const client = {
    from(table: string) {
      assert.equal(table, "products");
      const query = {
        insert(fields: Record<string, unknown>) {
          written = fields;
          return query;
        },
        select() {
          return query;
        },
        async single() {
          return { data: { ...productRow(1), ...written }, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const result = await putProduct(
    client,
    shopId,
    { name: "商品1", category: "饮品", costMills: 614, priceCents: 200 },
    id(1),
  );
  assert.equal(written?.purchase_unit_cost_mills, 614);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(written, "purchase_unit_cost_cents"),
  );
  assert.equal(result.costMills, 614);
});

test("销售RPC只发送当时厘成本快照并保持创建请求标识", async () => {
  let parameters: Record<string, unknown> | undefined;
  const snapshot = saleRow(1);
  snapshot.occurred_at = timestamp;
  (snapshot.sale_items as Record<string, unknown>[])[0].unit_cost_mills = 614;
  const client = {
    async rpc(name: string, values: Record<string, unknown>) {
      assert.equal(name, "save_sale");
      parameters = values;
      return { data: { id: id(1) }, error: null };
    },
    from(table: string) {
      assert.equal(table, "sales");
      const query = {
        select(value: string) {
          assert.equal(value, "*,sale_items(*)");
          return query;
        },
        eq() {
          return query;
        },
        async single() {
          return { data: snapshot, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const result = await putSale(
    client,
    shopId,
    {
      businessDate: day,
      items: [
        {
          productId: id(1),
          name: "商品1",
          category: "饮品",
          quantity: 1,
          unitPriceCents: 200,
          unitCostMills: 614,
        },
      ],
      extraIncomeCents: 0,
      note: "",
      occurredAt: timestamp,
    },
    id(1),
    id(9),
  );
  assert.equal(parameters?.p_request_id, id(9));
  assert.equal(parameters?.p_expected_version, null);
  assert.equal(parameters?.p_occurred_at, timestamp);
  assert.equal(Object.hasOwn(parameters!, "p_sales_only"), false);
  assert.equal(result.occurredAt, timestamp);
  const item = (parameters?.p_items as Record<string, unknown>[])[0];
  assert.equal(item.unitCostMills, 614);
  assert.ok(!Object.prototype.hasOwnProperty.call(item, "unitCostCents"));
  assert.equal(result.items[0].unitCostMills, 614);
});

test("仅补记销售明确发送不改库存参数，普通销售默认行为不变", async () => {
  let sent: Record<string, unknown> | undefined;
  const snapshot = saleRow(1);
  const client = {
    async rpc(_name: string, values: Record<string, unknown>) {
      sent = values;
      return { data: { id: id(1) }, error: null };
    },
    from() {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        async single() {
          return { data: snapshot, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  await putSale(
    client,
    shopId,
    {
      businessDate: day,
      items: [],
      extraIncomeCents: 0,
      note: "",
      salesOnly: true,
    },
    id(1),
    id(9),
  );
  assert.equal(sent?.p_sales_only, true);
  assert.equal(sent?.p_expected_version, null);
});

test("商品创建重试必须比较精确厘成本，不能把0.614与旧0.61当成同一请求", async () => {
  const conflict = { code: "23505", message: "duplicate" };
  for (const preciseCost of [614, 610]) {
    let call = 0;
    const client = {
      from() {
        call += 1;
        const read = call > 1;
        const query = {
          insert() {
            return query;
          },
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async single() {
            return read
              ? {
                  data: {
                    ...productRow(1),
                    purchase_unit_cost_mills: preciseCost,
                  },
                  error: null,
                }
              : { data: null, error: conflict };
          },
        };
        return query;
      },
    } as unknown as SupabaseClient;
    const pending = putProduct(
      client,
      shopId,
      { name: "商品1", category: "饮品", costMills: 614, priceCents: 200 },
      id(1),
    );
    if (preciseCost === 614) assert.equal((await pending).costMills, 614);
    else await assert.rejects(pending, (reason) => reason === conflict);
  }
});

test("库存读取保留未知与零库存差别，进货保留三位成本", async () => {
  const { client } = memoryClient({
    products: [productRow(1), productRow(2)],
    inventory_levels: [
      {
        id: id(1),
        shop_id: shopId,
        product_id: id(1),
        quantity: "0",
        initialized_at: timestamp,
        counted_at: timestamp,
      },
    ],
    inventory_receipts: [
      {
        id: id(3),
        shop_id: shopId,
        product_id: id(1),
        quantity: "10",
        unit_cost_mills: "445",
        business_date: day,
        created_at: timestamp,
        note: "新进货",
      },
    ],
  });
  const ledger = await loadLedger(client, shopId);
  assert.deepEqual(ledger.inventory, [
    {
      productId: id(1),
      quantity: 0,
      initializedAt: timestamp,
      countedAt: timestamp,
    },
  ]);
  assert.equal(ledger.inventoryReceipts?.[0].unitCostMills, 445);
  assert.equal(
    ledger.inventory?.some((r) => r.productId === id(2)),
    false,
  );
});

test("盘点和进货经数据库RPC提交，传递请求标识与期望库存", async () => {
  const calls: unknown[] = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return {
        error: null,
        data: {
          id: id(3),
          product_id: id(1),
          business_date: day,
          quantity: 10,
          unit_cost_mills: 445,
          note: "",
          created_at: timestamp,
        },
      };
    },
  } as unknown as SupabaseClient;
  await countInventory(client, id(1), 20, id(2), null);
  const receipt = await receiveInventory(
    client,
    {
      productId: id(1),
      businessDate: day,
      quantity: 10,
      unitCostMills: 445,
      note: "",
    },
    id(3),
  );
  assert.deepEqual(calls[0], {
    name: "count_inventory",
    args: {
      p_product_id: id(1),
      p_quantity: 20,
      p_request_id: id(2),
      p_expected_quantity: null,
    },
  });
  assert.equal((calls[1] as { name: string }).name, "receive_inventory");
  assert.equal(receipt.unitCostMills, 445);
});

test("任一库存页失败时整账本加载失败，不伪装成未盘点", async () => {
  for (const table of ["inventory_levels", "inventory_receipts"]) {
    const error = new Error("库存网络失败");
    const { client } = memoryClient({}, (read) =>
      read.table === table ? { data: null, error } : undefined,
    );
    await assert.rejects(loadLedger(client, shopId), error);
  }
});
