import test from "node:test";
import assert from "node:assert/strict";
import {
  dateRange,
  dateToday,
  formatCny,
  formatUnitCost,
  MAX_SALE_CENTS,
  MAX_UNIT_CENTS,
  MAX_UNIT_MILLS,
  parseMoney,
  parseUnitCost,
  profitRate,
  rankProducts,
  saleTotals,
  saleItemCostCents,
  summarize,
  trend,
  validateDate,
  validateExpense,
  validateProduct,
  validateSale,
} from "./domain.ts";
import type { Expense, Ledger, Product, Sale, SaleItem } from "./domain.ts";

const item: SaleItem = {
  productId: "water",
  name: "矿泉水",
  category: "饮品",
  quantity: 3,
  unitPriceCents: 250,
  unitCostMills: 1000,
};
const sale = (overrides: Partial<Sale> = {}): Sale => ({
  id: "s1",
  businessDate: "2026-10-15",
  items: [{ ...item }],
  extraIncomeCents: 200,
  note: "",
  version: 1,
  voidedAt: null,
  createdAt: "2026-10-15T01:00:00Z",
  ...overrides,
});
const expense = (overrides: Partial<Expense> = {}): Expense => ({
  id: "e1",
  businessDate: "2026-10-15",
  category: "transport",
  amountCents: 150,
  note: "运费",
  deletedAt: null,
  createdAt: "2026-10-15T01:00:00Z",
  ...overrides,
});
const product: Product = {
  id: "water",
  name: "矿泉水改名",
  category: "新分类",
  costMills: 8000,
  priceCents: 1000,
  deletedAt: null,
  updatedAt: "2026-10-16T01:00:00Z",
};
const ledger = (overrides: Partial<Ledger> = {}): Ledger => ({
  products: [product],
  sales: [sale()],
  expenses: [expense()],
  ...overrides,
});
const day = "2026-10-15";

test("金额文本按分精确解析，0.29不受浮点乘法影响", () => {
  assert.equal(parseMoney("0.29"), 29);
  assert.equal(parseMoney("12.3"), 1230);
  assert.equal(parseMoney(" 12 "), 1200);
  assert.equal(parseMoney("0"), 0);
  assert.equal(parseMoney("0.00"), 0);
  assert.equal(parseMoney("90071992547409.91"), Number.MAX_SAFE_INTEGER);
});

test("拒绝小数超位、负数、科学计数法、千分位和空金额", () => {
  for (const input of [
    "",
    " ",
    "NaN",
    "Infinity",
    "-1",
    "+1",
    "1e2",
    "1,000",
    "1.001",
    ".5",
    "01",
    "1.",
    "0x10",
    "90071992547409.92",
  ]) {
    assert.throws(() => parseMoney(input), Error, input);
  }
  assert.throws(() => parseMoney("0.00", { allowZero: false }), /大于0/);
  assert.equal(parseMoney("0.01", { allowZero: false }), 1);
});

test("人民币展示保留两位小数，包括负数及安全整数边界", () => {
  assert.equal(formatCny(0), "¥0.00");
  assert.equal(formatCny(123456), "¥1,234.56");
  assert.equal(formatCny(-1), "-¥0.01");
  assert.equal(formatCny(Number.MAX_SAFE_INTEGER), "¥90,071,992,547,409.91");
  for (const value of [NaN, Infinity, -Infinity, 1.5])
    assert.throws(() => formatCny(value));
});

test("单位成本按整数厘精确解析，保留三位且不改变收款金额精度", () => {
  assert.equal(parseUnitCost("0.614"), 614);
  assert.equal(parseUnitCost("0.445"), 445);
  assert.equal(parseUnitCost("0.93"), 930);
  assert.equal(parseUnitCost(" 12.3 "), 12300);
  assert.equal(parseUnitCost("0"), 0);
  assert.equal(parseUnitCost("9007199254740.991"), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseMoney("0.614"), /两位/);
  for (const value of [
    "",
    " ",
    "0.6140",
    ".445",
    "01",
    "1.",
    "-1",
    "+1",
    "1e-3",
    "1,000",
    "NaN",
    "Infinity",
    "9007199254740.992",
  ])
    assert.throws(() => parseUnitCost(value), Error, value);
});

test("单位成本展示保留三位，包括负数与安全整数边界", () => {
  assert.equal(formatUnitCost(614), "¥0.614");
  assert.equal(formatUnitCost(445), "¥0.445");
  assert.equal(formatUnitCost(930), "¥0.930");
  assert.equal(formatUnitCost(0), "¥0.000");
  assert.equal(formatUnitCost(-5), "-¥0.005");
  assert.equal(
    formatUnitCost(Number.MAX_SAFE_INTEGER),
    "¥9,007,199,254,740.991",
  );
  for (const value of [NaN, Infinity, -Infinity, 1.1])
    assert.throws(() => formatUnitCost(value));
});

test("明细成本先乘数量再按分四舍五入，不能先舍入单位成本", () => {
  assert.equal(saleItemCostCents({ quantity: 1, unitCostMills: 614 }), 61);
  assert.equal(saleItemCostCents({ quantity: 10, unitCostMills: 614 }), 614);
  assert.equal(saleItemCostCents({ quantity: 1, unitCostMills: 445 }), 45);
  assert.equal(saleItemCostCents({ quantity: 2, unitCostMills: 445 }), 89);
  assert.equal(saleItemCostCents({ quantity: 1, unitCostMills: 5 }), 1);
  assert.equal(saleItemCostCents({ quantity: 1, unitCostMills: 4 }), 0);
  for (const quantity of [0, -1, 1.5, MAX_UNIT_MILLS])
    assert.throws(() => saleItemCostCents({ quantity, unitCostMills: 445 }));
  for (const unitCostMills of [-1, 0.1, Infinity, MAX_UNIT_MILLS + 1])
    assert.throws(() => saleItemCostCents({ quantity: 1, unitCostMills }));
});

test("两条厘成本明细逐行舍入，订单、概览、趋势与商品排行完全一致", () => {
  const fractionalItem = { ...item, quantity: 1, unitCostMills: 445 };
  const fractionalSale = sale({
    items: [fractionalItem, { ...fractionalItem }],
    extraIncomeCents: 0,
  });
  const book = ledger({ sales: [fractionalSale], expenses: [] });
  assert.equal(saleTotals(fractionalSale).cost, 90);
  assert.equal(summarize(book, day, day).cost, 90);
  assert.equal(summarize(book, day, day).profit, 410);
  assert.equal(rankProducts(book, day, day)[0].cost, 90);
  assert.equal(rankProducts(book, day, day)[0].grossProfit, 410);
  assert.equal(trend(book, day, day)[0].profit, 410);
  const changedCurrentProduct = ledger({
    ...book,
    products: [{ ...product, costMills: 999 }],
  });
  assert.equal(summarize(changedCurrentProduct, day, day).cost, 90);
});

test("原整数分单位成本等值换算成厘后，每行结果仍完全一致", () => {
  for (const cents of [0, 1, 29, 61, 100, 9999, MAX_UNIT_CENTS]) {
    for (const quantity of [1, 3, 10, 100000]) {
      assert.equal(
        saleItemCostCents({ quantity, unitCostMills: cents * 10 }),
        cents * quantity,
      );
    }
  }
  assert.equal(
    validateProduct({
      name: "厘成本商品",
      category: "",
      costMills: MAX_UNIT_MILLS,
      priceCents: 0,
    }).costMills,
    MAX_UNIT_MILLS,
  );
});

test("利润率在零收入时没有定义，亏损时为负", () => {
  assert.equal(profitRate(-150, 0), null);
  assert.equal(profitRate(-250, 500), -50);
  assert.equal(profitRate(100, 400), 25);
  for (const value of [NaN, Infinity, -Infinity])
    assert.throws(() => profitRate(value, 100));
  assert.throws(() => profitRate(1, -1));
});

test("真实日历校验拒绝自动滚入下月的日期", () => {
  assert.equal(validateDate("2024-02-29"), "2024-02-29");
  assert.equal(validateDate("2000-02-29"), "2000-02-29");
  assert.equal(validateDate("0001-01-01"), "0001-01-01");
  for (const value of [
    "2026-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-10-00",
    "2026-1-1",
    "0000-01-01",
    "2026-10-15T00:00:00Z",
  ]) {
    assert.throws(() => validateDate(value), Error, value);
  }
});

test("今日按上海时区计算，准确处理UTC日期边界", () => {
  assert.equal(dateToday(new Date("2026-10-14T15:59:59.999Z")), "2026-10-14");
  assert.equal(dateToday(new Date("2026-10-14T16:00:00.000Z")), "2026-10-15");
  assert.equal(dateToday(new Date("2026-12-31T16:00:00Z")), "2027-01-01");
  assert.throws(() => dateToday(new Date("invalid")), /无效/);
});

test("本周从周一开始，本月截至今日，正确跨年", () => {
  assert.deepEqual(dateRange("today", day), { from: day, to: day });
  assert.deepEqual(dateRange("week", day), { from: "2026-10-12", to: day });
  assert.deepEqual(dateRange("week", "2026-10-18"), {
    from: "2026-10-12",
    to: "2026-10-18",
  });
  assert.deepEqual(dateRange("week", "2026-10-19"), {
    from: "2026-10-19",
    to: "2026-10-19",
  });
  assert.deepEqual(dateRange("week", "2027-01-01"), {
    from: "2026-12-28",
    to: "2027-01-01",
  });
  assert.deepEqual(dateRange("month", "2024-02-29"), {
    from: "2024-02-01",
    to: "2024-02-29",
  });
});

test("销售使用成交单价与成本快照，加上其他营业收入", () => {
  assert.deepEqual(saleTotals(sale()), {
    productRevenue: 750,
    extraIncome: 200,
    revenue: 950,
    cost: 300,
    grossProfit: 650,
  });
  assert.deepEqual(summarize(ledger(), day, day), {
    revenue: 950,
    cost: 300,
    grossProfit: 650,
    expenses: 150,
    profit: 500,
    margin: (500 / 950) * 100,
    quantity: 3,
    saleCount: 1,
  });
});

test("调价、重命名、停用商品及未出售进货不影响历史销售", () => {
  const expected = summarize(ledger(), day, day);
  const changed = ledger({
    products: [
      {
        ...product,
        costMills: MAX_UNIT_MILLS,
        priceCents: 0,
        deletedAt: "2026-10-16T00:00:00Z",
      },
      { ...product, id: "unsold", name: "未售库存", costMills: 200000 },
    ],
  });
  assert.deepEqual(summarize(changed, day, day), expected);
  assert.equal(rankProducts(changed, day, day)[0].name, "矿泉水");
});

test("免费销售、亏损销售和只有费用的日子均能正确核算", () => {
  assert.equal(
    saleTotals(
      sale({ items: [{ ...item, unitPriceCents: 0 }], extraIncomeCents: 0 }),
    ).grossProfit,
    -300,
  );
  const onlyExpense = summarize(ledger({ sales: [] }), day, day);
  assert.equal(onlyExpense.profit, -150);
  assert.equal(onlyExpense.margin, null);
});

test("作废销售和已删除费用不计入汇总及排行", () => {
  const book = ledger({
    sales: [sale(), sale({ id: "void", voidedAt: "2026-10-15T02:00:00Z" })],
    expenses: [
      expense(),
      expense({ id: "deleted", deletedAt: "2026-10-15T02:00:00Z" }),
    ],
  });
  assert.equal(summarize(book, day, day).profit, 500);
  assert.equal(summarize(book, day, day).saleCount, 1);
  assert.equal(rankProducts(book, day, day)[0].quantity, 3);
});

test("日期区间包含首尾，并排除区间外记录", () => {
  const book = ledger({
    sales: [
      sale({ businessDate: "2026-10-14" }),
      sale(),
      sale({ businessDate: "2026-10-16" }),
    ],
  });
  assert.equal(summarize(book, day, "2026-10-16").saleCount, 2);
  assert.equal(summarize(book, day, day).saleCount, 1);
  assert.throws(() => summarize(book, "2026-10-16", day), /开始日期/);
});

test("趋势补齐没有销售的日期，只有费用时显示负利润", () => {
  const book = ledger({ expenses: [expense({ businessDate: "2026-10-16" })] });
  assert.deepEqual(trend(book, "2026-10-14", "2026-10-17"), [
    { date: "2026-10-14", revenue: 0, profit: 0 },
    { date: day, revenue: 950, profit: 650 },
    { date: "2026-10-16", revenue: 0, profit: -150 },
    { date: "2026-10-17", revenue: 0, profit: 0 },
  ]);
  assert.equal(
    trend(ledger({ sales: [], expenses: [] }), "2024-02-28", "2024-03-01")
      .length,
    3,
  );
  assert.throws(() => trend(book, "1900-01-01", day), /3660/);
});

test("商品排行按商品编号聚合，同名商品独立，贡献不分摊配送费", () => {
  const book = ledger({
    sales: [
      sale({
        items: [
          item,
          { ...item, productId: "water2", quantity: 1 },
          { ...item, quantity: 2 },
        ],
      }),
    ],
  });
  assert.deepEqual(rankProducts(book, day, day), [
    {
      productId: "water",
      name: "矿泉水",
      category: "饮品",
      quantity: 5,
      revenue: 1250,
      cost: 500,
      grossProfit: 750,
    },
    {
      productId: "water2",
      name: "矿泉水",
      category: "饮品",
      quantity: 1,
      revenue: 250,
      cost: 100,
      grossProfit: 150,
    },
  ]);
});

test("商品排行选择区间内最新销售快照名称，不依赖数组顺序", () => {
  const old = sale({ businessDate: "2026-10-14" });
  const newer = sale({
    id: "s2",
    items: [{ ...item, name: "新名称", category: "新分类" }],
  });
  const rank = rankProducts(ledger({ sales: [newer, old] }), "2026-10-14", day);
  assert.equal(rank[0].name, "新名称");
  assert.equal(rank[0].category, "新分类");
});

test("商品验证可用于没有编号的表单草稿，并拒绝非法单价", () => {
  const draft = {
    name: "茶叶蛋",
    category: "",
    costMills: 0,
    priceCents: MAX_UNIT_CENTS,
  };
  assert.equal(validateProduct(draft), draft);
  for (const value of [NaN, Infinity, -Infinity, 1.1, -1, MAX_UNIT_MILLS + 1])
    assert.throws(() => validateProduct({ ...draft, costMills: value }));
  assert.throws(() => validateProduct({ ...draft, name: "  " }));
  assert.throws(() => validateProduct({ ...draft, name: "字".repeat(121) }));
});

test("销售验证拒绝空明细、非法数量、非法日期和超长备注", () => {
  assert.equal(validateSale(sale()).businessDate, day);
  assert.throws(() => validateSale(sale({ items: [] })), /至少/);
  for (const value of [0, -1, 0.5, 100001, Infinity, NaN])
    assert.throws(() =>
      validateSale(sale({ items: [{ ...item, quantity: value }] })),
    );
  assert.throws(() => validateSale(sale({ businessDate: "2026-02-30" })));
  assert.throws(() => validateSale(sale({ note: "a".repeat(501) })));
  assert.throws(() => validateSale(sale({ extraIncomeCents: NaN })));
  assert.throws(
    () =>
      saleTotals({ items: [null as unknown as SaleItem], extraIncomeCents: 0 }),
    /销售明细格式无效/,
  );
  assert.throws(
    () => validateProduct(null as unknown as Product),
    /商品格式无效/,
  );
  assert.throws(
    () => validateSale(null as unknown as Sale),
    /销售记录格式无效/,
  );
  assert.throws(
    () => validateExpense(null as unknown as Expense),
    /经营费用格式无效/,
  );
});

test("每笔销售收入和成本的上限均被校验", () => {
  const limit = sale({
    items: [
      {
        ...item,
        quantity: 10000,
        unitPriceCents: MAX_UNIT_CENTS,
        unitCostMills: MAX_UNIT_MILLS,
      },
    ],
    extraIncomeCents: 0,
  });
  assert.equal(saleTotals(limit).revenue, MAX_SALE_CENTS);
  assert.throws(() => saleTotals({ ...limit, extraIncomeCents: 1 }), /100亿元/);
  assert.throws(
    () =>
      saleTotals(
        sale({
          items: [
            {
              ...item,
              quantity: 10001,
              unitPriceCents: 0,
              unitCostMills: MAX_UNIT_MILLS,
            },
          ],
          extraIncomeCents: 0,
        }),
      ),
    /100亿元/,
  );
});

test("费用必须为正整数分并使用已支持的类别", () => {
  assert.equal(validateExpense(expense()).amountCents, 150);
  for (const value of [0, -1, 1.5, Infinity, NaN, MAX_SALE_CENTS + 1])
    assert.throws(() => validateExpense(expense({ amountCents: value })));
  assert.throws(
    () =>
      validateExpense({
        ...expense(),
        category: "unknown" as Expense["category"],
      }),
    /类别/,
  );
});

test("汇总拒绝safe integer溢出，避免大数据量时静默损失一分钱", () => {
  const bigSale = sale({
    items: [
      {
        ...item,
        quantity: 10000,
        unitPriceCents: MAX_UNIT_CENTS,
        unitCostMills: 0,
      },
    ],
    extraIncomeCents: 0,
  });
  const manySales = Array.from({ length: 9008 }, (_, i) => ({
    ...bigSale,
    id: `s${i}`,
  }));
  assert.throws(
    () => summarize(ledger({ sales: manySales, expenses: [] }), day, day),
    /安全计算范围/,
  );
  assert.throws(
    () => trend(ledger({ sales: manySales, expenses: [] }), day, day),
    /安全计算范围/,
  );
  assert.throws(
    () => rankProducts(ledger({ sales: manySales, expenses: [] }), day, day),
    /安全计算范围/,
  );
});
