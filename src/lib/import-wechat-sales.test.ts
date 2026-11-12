import test from "node:test";
import assert from "node:assert/strict";
import { importWechatSales } from "./import-wechat-sales.ts";
import { wechatProductId, wechatSaleId } from "./wechat-receipts.ts";
import { saleTotals, type Ledger, type Product, type Sale } from "./domain.ts";
import type { ProductDraft, SaleDraft } from "./cloud-repository.ts";
import type {
  WechatImportInput,
  WechatReceipt,
} from "./wechat-import-types.ts";

const shopId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const product: Product = {
  id: productId,
  name: "原有商品",
  category: "饮品",
  costMills: 800,
  priceCents: 300,
  deletedAt: null,
  updatedAt: "2026-10-18T00:00:00Z",
};
const receipt = (n = 1): WechatReceipt => ({
  fingerprint: n.toString(16).padStart(64, "0"),
  sourceRow: n + 3,
  paidAt: `2026-10-18 12:00:${String(n).padStart(2, "0")}`,
  businessDate: "2026-10-18",
  totalCents: 650,
  items: [{ name: "来源商品", quantity: 2, unitPriceCents: 300 }],
  extraIncomeCents: 50,
  refundMarked: false,
  issues: [],
});
const input = (receipts = [receipt()]): WechatImportInput => ({
  merchantName: "测试门店",
  receipts,
  products: [
    { sourceName: "来源商品", productId, costMills: 1000, priceCents: 300 },
  ],
  confirmedPaidNoRefund: true,
});
function savedSale(id: string, draft?: SaleDraft): Sale {
  return {
    id,
    businessDate: draft?.businessDate ?? "2026-10-18",
    items: draft?.items ?? [],
    extraIncomeCents: draft?.extraIncomeCents ?? 0,
    note: draft?.note ?? "原始历史单据",
    version: 1,
    voidedAt: null,
    createdAt: "2026-10-18T04:00:00Z",
  };
}

function memory(initial: Partial<Ledger> = {}) {
  let remote: Ledger = structuredClone({
    products: [product],
    sales: [],
    expenses: [],
    ...initial,
  });
  let current = true;
  let refreshCount = 0;
  const productWrites: { id: string; draft: ProductDraft }[] = [];
  const saleWrites: { id: string; draft: SaleDraft }[] = [];
  const published: Ledger[] = [];
  const hooks: {
    product?: (draft: ProductDraft, id: string) => Promise<Product>;
    sale?: (draft: SaleDraft, id: string) => Promise<Sale>;
    refresh?: () => Promise<Ledger>;
  } = {};
  const deps = {
    shopId,
    ledger: structuredClone(remote),
    isCurrent: () => current,
    async createProduct(draft: ProductDraft, id: string) {
      productWrites.push({ id, draft: structuredClone(draft) });
      if (hooks.product) return hooks.product(draft, id);
      const created: Product = {
        id,
        ...draft,
        deletedAt: null,
        updatedAt: "2026-10-18T00:00:00Z",
      };
      remote.products.push(created);
      return created;
    },
    async createSale(draft: SaleDraft, id: string) {
      saleWrites.push({ id, draft: structuredClone(draft) });
      if (hooks.sale) return hooks.sale(draft, id);
      assert.ok(!remote.sales.some((sale) => sale.id === id));
      const created = savedSale(id, draft);
      remote.sales.push(created);
      return created;
    },
    async loadLedger() {
      refreshCount += 1;
      return hooks.refresh ? hooks.refresh() : structuredClone(remote);
    },
    onLedger(next: Ledger) {
      published.push(structuredClone(next));
    },
  };
  return {
    deps,
    hooks,
    productWrites,
    saleWrites,
    published,
    get remote() {
      return remote;
    },
    set remote(next: Ledger) {
      remote = next;
    },
    get refreshCount() {
      return refreshCount;
    },
    switchAccount() {
      current = false;
    },
  };
}

test("imports reviewed cost snapshots without overwriting the selected product", async () => {
  const m = memory();
  const outcome = await importWechatSales(input(), m.deps);
  assert.deepEqual(outcome.result, {
    imported: 1,
    skipped: 0,
    createdProducts: 0,
    failed: 0,
    errors: [],
  });
  assert.equal(m.productWrites.length, 0);
  assert.equal(m.remote.products[0].costMills, 800);
  const draft = m.saleWrites[0].draft;
  assert.equal(draft.occurredAt, "2026-10-18T04:00:01.000Z");
  assert.equal(draft.items[0].unitCostMills, 1000);
  assert.equal(draft.items[0].unitPriceCents, 300);
  assert.equal(draft.items[0].name, product.name);
  assert.equal(draft.items[0].category, product.category);
  assert.equal(draft.extraIncomeCents, 50);
  assert.equal(
    m.saleWrites[0].id,
    await wechatSaleId(shopId, receipt().fingerprint),
  );
});

test("sales-only import keeps receipt identity, totals and explicit no-stock flag", async () => {
  const m = memory();
  const data = input();
  data.salesOnly = true;
  const result = await importWechatSales(data, m.deps);
  assert.equal(result.result.imported, 1);
  assert.equal(m.saleWrites[0].draft.salesOnly, true);
  assert.equal(
    m.saleWrites[0].id,
    await wechatSaleId(shopId, receipt().fingerprint),
  );
  assert.equal(saleTotals(m.saleWrites[0].draft).revenue, 650);
  assert.equal(saleTotals(m.saleWrites[0].draft).cost, 200);
  m.deps.ledger = structuredClone(m.remote);
  const retry = await importWechatSales(data, m.deps);
  assert.equal(retry.result.skipped, 1);
  assert.equal(m.saleWrites.length, 1);
});

test("normal imports retain stock behavior; invalid sales-only flags fail before writes", async () => {
  const m = memory();
  await importWechatSales(input(), m.deps);
  assert.equal(m.saleWrites[0].draft.salesOnly, undefined);
  for (const flag of ["true", null, 1]) {
    const data = input();
    Object.assign(data, { salesOnly: flag });
    const invalid = memory();
    await assert.rejects(importWechatSales(data, invalid.deps), /入账方式/);
    assert.equal(invalid.saleWrites.length + invalid.productWrites.length, 0);
  }
});

test("retains three-decimal unit costs and rounds only each quantity-adjusted line", async () => {
  const m = memory();
  const data = input([
    {
      ...receipt(),
      totalCents: 1240,
      items: [
        { name: "来源商品", quantity: 4, unitPriceCents: 200 },
        { name: "第二商品", quantity: 5, unitPriceCents: 78 },
      ],
    },
  ]);
  data.products = [
    { sourceName: "来源商品", productId, costMills: 614, priceCents: 200 },
    { sourceName: "第二商品", costMills: 445, priceCents: 78 },
  ];
  const outcome = await importWechatSales(data, m.deps);
  assert.equal(outcome.result.imported, 1);
  assert.deepEqual(
    m.saleWrites[0].draft.items.map((item) => item.unitCostMills),
    [614, 445],
  );
  assert.equal(m.remote.products[0].costMills, 800);
  assert.equal(m.productWrites[0].draft.costMills, 445);
  assert.equal(saleTotals(m.saleWrites[0].draft).cost, 469);
  assert.equal(saleTotals(m.saleWrites[0].draft).revenue, 1240);
});

test("reimport ignores changed reviewed cost and requires no binding for an existing sale", async () => {
  const id = await wechatSaleId(shopId, receipt().fingerprint);
  const old = savedSale(id);
  old.version = 4;
  const m = memory({ sales: [old] });
  const data = input();
  data.products = [];
  const outcome = await importWechatSales(data, m.deps);
  assert.equal(outcome.result.skipped, 1);
  assert.equal(m.saleWrites.length, 0);
  assert.deepEqual(outcome.ledger?.sales[0], old);
});

test("voided sales also block reimport and are never revived", async () => {
  const old = savedSale(await wechatSaleId(shopId, receipt().fingerprint));
  old.voidedAt = "2026-10-19T00:00:00Z";
  const m = memory({ sales: [old] });
  const outcome = await importWechatSales(input(), m.deps);
  assert.equal(outcome.result.skipped, 1);
  assert.equal(m.saleWrites.length, 0);
  assert.equal(outcome.ledger?.sales[0].voidedAt, old.voidedAt);
});

test("new products use stable identities and are created at most once per batch", async () => {
  const m = memory();
  const data = input([receipt(1), receipt(2)]);
  delete data.products[0].productId;
  const outcome = await importWechatSales(data, m.deps);
  assert.equal(outcome.result.createdProducts, 1);
  assert.equal(outcome.result.imported, 2);
  assert.equal(m.productWrites.length, 1);
  assert.equal(
    m.productWrites[0].id,
    await wechatProductId(shopId, data.merchantName, "来源商品"),
  );
  assert.deepEqual(m.productWrites[0].draft, {
    name: "来源商品",
    category: "微信导入",
    costMills: 1000,
    priceCents: 300,
  });
});

test("stable existing import product is reused without updating price or cost", async () => {
  const id = await wechatProductId(shopId, "测试门店", "来源商品");
  const old = { ...product, id, name: "来源商品", category: "微信导入" };
  const m = memory({ products: [old] });
  const data = input();
  delete data.products[0].productId;
  await importWechatSales(data, m.deps);
  assert.equal(m.productWrites.length, 0);
  assert.equal(m.remote.products[0].costMills, 800);
});

test("validates all bindings before any write, including missing costs", async () => {
  const m = memory();
  const data = input([
    receipt(1),
    {
      ...receipt(2),
      items: [{ name: "第二商品", quantity: 2, unitPriceCents: 300 }],
    },
  ]);
  data.products.push({
    sourceName: "第二商品",
    costMills: NaN,
    priceCents: 300,
  });
  await assert.rejects(importWechatSales(data, m.deps));
  assert.equal(m.saleWrites.length + m.productWrites.length, 0);
});

test("explicitly reviewed zero cost is allowed but a missing cost is blocked", async () => {
  const data = input();
  data.products[0].costMills = 0;
  const m = memory();
  assert.equal((await importWechatSales(data, m.deps)).result.imported, 1);
  delete (data.products[0] as Partial<(typeof data.products)[0]>).costMills;
  await assert.rejects(importWechatSales(data, memory().deps));
});

test("unconfirmed payment, refunds, row issues and inconsistent totals all fail before writes", async () => {
  const variations = [
    (data: WechatImportInput) => {
      data.confirmedPaidNoRefund = false;
    },
    (data: WechatImportInput) => {
      data.receipts[1].refundMarked = true;
    },
    (data: WechatImportInput) => {
      data.receipts[1].issues = ["待核对"];
    },
    (data: WechatImportInput) => {
      data.receipts[1].totalCents += 1;
    },
    (data: WechatImportInput) => {
      data.receipts[1].paidAt = "2026-10-18 25:00:00";
    },
  ];
  for (const change of variations) {
    const m = memory();
    const data = input([receipt(1), receipt(2)]);
    change(data);
    await assert.rejects(importWechatSales(data, m.deps));
    assert.equal(m.saleWrites.length + m.productWrites.length, 0);
  }
});

test("partial failure keeps committed sales and retry only adds unfinished receipts", async () => {
  const m = memory();
  m.hooks.sale = async (draft, id) => {
    if (m.saleWrites.length === 2) throw new Error("offline");
    const saved = savedSale(id, draft);
    m.remote.sales.push(saved);
    return saved;
  };
  const data = input([receipt(1), receipt(2), receipt(3)]);
  const first = await importWechatSales(data, m.deps);
  assert.equal(first.result.imported, 1);
  assert.equal(first.result.failed, 2);
  assert.equal(first.ledger?.sales.length, 1);
  assert.equal(m.refreshCount, 1);
  assert.equal(m.saleWrites.length, 2);
  m.hooks.sale = undefined;
  m.deps.ledger = first.ledger!;
  const second = await importWechatSales(data, m.deps);
  assert.equal(second.result.skipped, 1);
  assert.equal(second.result.imported, 2);
  assert.equal(m.remote.sales.length, 3);
});

test("stock failure identifies the product, keeps prior sales and stops without retrying writes", async () => {
  const m = memory();
  m.hooks.sale = async (draft, id) => {
    if (m.saleWrites.length === 2)
      throw {
        code: "23514",
        message: "库存不足或数量超出上限：测试饮料。请核对进货和实际销售数量",
        details: "private backend detail",
        hint: "private backend hint",
      };
    const saved = savedSale(id, draft);
    m.remote.sales.push(saved);
    return saved;
  };
  const data = input([receipt(1), receipt(2), receipt(3)]);
  const first = await importWechatSales(data, m.deps);
  assert.equal(first.result.imported, 1);
  assert.equal(first.result.failed, 2);
  assert.equal(first.ledger?.sales.length, 1);
  assert.equal(m.refreshCount, 1);
  assert.equal(m.saleWrites.length, 2);
  assert.equal(
    first.result.errors[0].message,
    "库存不足或数量超出上限：测试饮料。请核对进货和实际销售数量。本条尚未导入，请先核对“库存与进货”，再重新导入。",
  );
  assert.match(first.result.errors[1].message, /本条尚未导入/);
  assert.ok(!JSON.stringify(first.result).includes("private backend"));

  // After the owner fixes the stock records, an explicit retry skips prior sales.
  m.hooks.sale = undefined;
  m.deps.ledger = first.ledger!;
  const second = await importWechatSales(data, m.deps);
  assert.equal(second.result.skipped, 1);
  assert.equal(second.result.imported, 2);
  assert.equal(m.remote.sales.length, 3);
});

test("import failures do not expose arbitrary backend or network messages", async () => {
  const stockMessage =
    "库存不足或数量超出上限：测试饮料。请核对进货和实际销售数量";
  for (const cause of [
    new Error("fetch failed: private network detail"),
    { code: "23514", message: "private database constraint detail" },
    { code: "42501", message: stockMessage },
    { code: "23514", message: `${stockMessage}\nprivate backend detail` },
    { code: "23514", message: `${stockMessage} private backend detail` },
    { code: "23514", message: { private: "backend detail" } },
  ]) {
    const m = memory();
    m.hooks.sale = async () => {
      throw cause;
    };
    const outcome = await importWechatSales(input(), m.deps);
    assert.equal(
      outcome.result.errors[0].message,
      "本条保存未完成，已停止后续导入；刷新后可重试。",
    );
    assert.equal(m.saleWrites.length, 1);
    assert.equal(m.refreshCount, 1);
  }
});

test("concurrent conflict is skipped only after the same stable sale is found in own ledger", async () => {
  const m = memory();
  m.hooks.sale = async (draft, id) => {
    const otherDevice = savedSale(id, draft);
    otherDevice.voidedAt = "2026-10-19T00:00:00Z";
    m.remote.sales.push(otherDevice);
    throw Object.assign(new Error("conflict"), { code: "23505" });
  };
  const result = await importWechatSales(input(), m.deps);
  assert.equal(result.result.skipped, 1);
  assert.equal(result.result.failed, 0);
  assert.ok(result.ledger?.sales[0].voidedAt);
  assert.equal(m.refreshCount, 1);
  assert.equal(m.saleWrites.length, 1);
});

test("unrelated unique errors never masquerade as duplicate imports", async () => {
  const m = memory();
  m.hooks.sale = async () => {
    throw Object.assign(new Error("unrelated"), { code: "23505" });
  };
  const outcome = await importWechatSales(input(), m.deps);
  assert.equal(outcome.result.skipped, 0);
  assert.equal(outcome.result.failed, 1);
  assert.equal(m.saleWrites.length, 1);
  assert.equal(m.refreshCount, 1);
});

test("account switch stops future writes and never publishes the old account ledger", async () => {
  const m = memory();
  m.hooks.sale = async (draft, id) => {
    m.remote.sales.push(savedSale(id, draft));
    m.switchAccount();
    return savedSale(id, draft);
  };
  const outcome = await importWechatSales(
    input([receipt(1), receipt(2)]),
    m.deps,
  );
  assert.equal(outcome.scopeChanged, true);
  assert.equal(outcome.ledger, null);
  assert.equal(m.saleWrites.length, 1);
  assert.equal(m.published.length, 0);
});

test("identity change during conflict refresh also cannot publish an old ledger", async () => {
  const m = memory();
  m.hooks.sale = async () => {
    throw new Error("timeout");
  };
  m.hooks.refresh = async () => {
    m.switchAccount();
    return m.remote;
  };
  const outcome = await importWechatSales(input(), m.deps);
  assert.equal(outcome.ledger, null);
  assert.equal(m.published.length, 0);
  assert.equal(m.saleWrites.length, 1);
});

test("unexpected extra customer fields are not persisted in products, notes or drafts", async () => {
  const m = memory();
  const data = input();
  Object.assign(data.receipts[0], {
    customer: "客户隐私名字",
    phone: "13800000000",
    address: "客户隐私地址",
  });
  await importWechatSales(data, m.deps);
  const sent = JSON.stringify([...m.saleWrites, ...m.productWrites]);
  for (const value of ["客户隐私名字", "13800000000", "客户隐私地址"])
    assert.ok(!sent.includes(value));
  assert.equal(
    m.saleWrites[0].draft.note,
    `微信小票 · 测试门店 · 2026-10-18 12:00:01 · 指纹:${receipt().fingerprint}`,
  );
});

test("inactive mappings or renamed deterministic products fail before writes", async () => {
  const inactive = memory({
    products: [{ ...product, deletedAt: "2026-10-18T00:00:00Z" }],
  });
  await assert.rejects(importWechatSales(input(), inactive.deps));
  assert.equal(inactive.saleWrites.length + inactive.productWrites.length, 0);
  const data = input();
  delete data.products[0].productId;
  const id = await wechatProductId(shopId, data.merchantName, "来源商品");
  const renamed = memory({
    products: [{ ...product, id, name: "已改名商品" }],
  });
  await assert.rejects(importWechatSales(data, renamed.deps));
  assert.equal(renamed.saleWrites.length + renamed.productWrites.length, 0);
});

test("uncertain product creation can recover by one read without rewriting the product", async () => {
  const m = memory();
  const data = input();
  delete data.products[0].productId;
  m.hooks.product = async (draft, id) => {
    m.remote.products.push({
      id,
      ...draft,
      deletedAt: null,
      updatedAt: "2026-10-18T00:00:00Z",
    });
    throw new Error("response lost");
  };
  const outcome = await importWechatSales(data, m.deps);
  assert.equal(outcome.result.imported, 1);
  assert.equal(m.productWrites.length, 1);
  assert.equal(m.refreshCount, 1);
});

test("one identical fingerprint repeated in a batch creates only one sale", async () => {
  const m = memory();
  const outcome = await importWechatSales(
    input([receipt(), receipt()]),
    m.deps,
  );
  assert.equal(outcome.result.imported, 1);
  assert.equal(outcome.result.skipped, 1);
  assert.equal(m.saleWrites.length, 1);
});
