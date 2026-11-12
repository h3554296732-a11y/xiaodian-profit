import test from "node:test";
import assert from "node:assert/strict";
import { inventoryWarnings, validateInventoryReceipt } from "./inventory.ts";
import type { Ledger, Sale } from "./domain.ts";

const item = {
  productId: "p",
  name: "饮料",
  category: "饮品",
  quantity: 4,
  unitPriceCents: 300,
  unitCostMills: 1000,
};
const sale = (
  businessDate: string,
  quantity = 4,
  voidedAt: string | null = null,
): Sale => ({
  id: businessDate,
  businessDate,
  items: [{ ...item, quantity }],
  extraIncomeCents: 0,
  note: "",
  version: 1,
  voidedAt,
  createdAt: `${businessDate}T12:00:00+08:00`,
});
const base: Ledger = {
  products: [
    {
      id: "p",
      name: "饮料",
      category: "饮品",
      costMills: 1000,
      priceCents: 300,
      deletedAt: null,
      updatedAt: "",
    },
  ],
  sales: [],
  expenses: [],
};
const tracked = (sales: Sale[], quantity = 20): Ledger => ({
  ...base,
  sales,
  inventory: [
    {
      productId: "p",
      quantity,
      initializedAt: "2026-10-24T00:00:00Z",
      countedAt: "2026-10-24T00:00:00Z",
    },
  ],
});

test("20件库存近7天卖4件，预计35天售完且超过默认30天预警", () => {
  const [row] = inventoryWarnings(tracked([sale("2026-10-24")]), "2026-10-24");
  assert.equal(row.daysRemaining, 35);
  assert.equal(row.status, "slow");
  assert.equal(
    inventoryWarnings(tracked([sale("2026-10-24")]), "2026-10-24", 40)[0]
      .status,
    "normal",
  );
});
test("近7天包含今天与6天前，排除更早、未来与作废单", () => {
  const [row] = inventoryWarnings(
    tracked([
      sale("2026-10-18", 2),
      sale("2026-10-24", 2),
      sale("2026-10-17", 99),
      sale("2026-10-25", 99),
      sale("2026-10-20", 99, "void"),
    ]),
    "2026-10-24",
  );
  assert.equal(row.sold7Days, 4);
});
test("未盘点保持未知，有库存无销量独立提示，零库存可区分", () => {
  assert.equal(inventoryWarnings(base, "2026-10-24")[0].quantity, null);
  assert.equal(inventoryWarnings(base, "2026-10-24")[0].status, "unknown");
  assert.equal(
    inventoryWarnings(tracked([]), "2026-10-24")[0].status,
    "no_sales",
  );
  assert.equal(
    inventoryWarnings(tracked([]), "2026-10-24")[0].daysRemaining,
    null,
  );
  assert.equal(
    inventoryWarnings(tracked([], 0), "2026-10-24")[0].status,
    "out_of_stock",
  );
});
test("停用商品不预警、阈值与进货整数和厘精度有校验", () => {
  assert.deepEqual(
    inventoryWarnings(
      { ...base, products: [{ ...base.products[0], deletedAt: "now" }] },
      "2026-10-24",
    ),
    [],
  );
  assert.throws(() => inventoryWarnings(base, "2026-10-24", 0));
  const draft = {
    productId: "p",
    businessDate: "2026-10-24",
    quantity: 10,
    unitCostMills: 445,
    note: "",
  };
  assert.equal(validateInventoryReceipt(draft).unitCostMills, 445);
  for (const quantity of [0, 1.5, 100001])
    assert.throws(() => validateInventoryReceipt({ ...draft, quantity }));
  assert.throws(() =>
    validateInventoryReceipt({ ...draft, unitCostMills: 445.5 }),
  );
});
