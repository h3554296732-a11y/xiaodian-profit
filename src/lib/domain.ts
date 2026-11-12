/** Receipts/prices use integer fen; unit costs use integer li (0.001 yuan). */
export type Product = {
  id: string;
  name: string;
  category: string;
  costMills: number;
  priceCents: number;
  deletedAt: string | null;
  updatedAt: string;
};

export type SaleItem = {
  productId: string;
  name: string;
  category: string;
  quantity: number;
  unitPriceCents: number;
  unitCostMills: number;
};

export type Sale = {
  id: string;
  businessDate: string;
  items: SaleItem[];
  extraIncomeCents: number;
  note: string;
  version: number;
  voidedAt: string | null;
  createdAt: string;
  /** Actual receipt time; absent on records written before inventory tracking. */
  occurredAt?: string;
};

export type InventoryBalance = {
  productId: string;
  quantity: number;
  initializedAt: string;
  countedAt: string;
};
export type InventoryReceipt = {
  id: string;
  productId: string;
  businessDate: string;
  quantity: number;
  unitCostMills: number;
  note: string;
  createdAt: string;
};

export const EXPENSE_CATEGORIES = [
  "transport",
  "packaging",
  "loss",
  "utilities",
  "rent",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type Expense = {
  id: string;
  businessDate: string;
  category: ExpenseCategory;
  amountCents: number;
  note: string;
  deletedAt: string | null;
  createdAt: string;
};

export type Ledger = {
  products: Product[];
  sales: Sale[];
  expenses: Expense[];
  inventory?: InventoryBalance[];
  inventoryReceipts?: InventoryReceipt[];
};
export const MAX_UNIT_CENTS = 100_000_000;
export const MAX_UNIT_MILLS = MAX_UNIT_CENTS * 10;
export const MAX_QUANTITY = 100_000;
export const MAX_SALE_CENTS = 1_000_000_000_000;

function integer(
  value: number,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}必须是${min}到${max}之间的整数`);
  }
  return value;
}

function safe(value: number, label = "汇总金额"): number {
  if (!Number.isSafeInteger(value))
    throw new Error(`${label}超出安全计算范围，请缩小查询范围`);
  return value;
}

function text(
  value: string,
  label: string,
  max: number,
  required = false,
): void {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  ) {
    throw new Error(
      `${label}${required ? "不能为空，且" : ""}最多${max}个字符`,
    );
  }
}

function record(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
}

/** Accept plain decimal yuan, never float multiplication, signs or scientific notation. */
export function parseMoney(
  input: string,
  options: { allowZero?: boolean } = {},
): number {
  if (typeof input !== "string")
    throw new Error("请输入正确的金额，最多保留两位小数");
  const value = input.trim();
  if (value.length > 32 || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("请输入正确的金额，最多保留两位小数");
  }
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("金额超出安全计算范围");
  if (options.allowZero === false && cents === 0n)
    throw new Error("金额必须大于0");
  return Number(cents);
}

/** Parse a reviewed unit cost exactly, retaining up to three decimal places. */
export function parseUnitCost(input: string): number {
  if (typeof input !== "string")
    throw new Error("请输入正确的单位成本，最多保留三位小数");
  const value = input.trim();
  if (value.length > 32 || !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value))
    throw new Error("请输入正确的单位成本，最多保留三位小数");
  const [whole, fraction = ""] = value.split(".");
  const mills = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
  if (mills > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("单位成本超出安全计算范围");
  return Number(mills);
}

/** Unit-cost display never rounds the third decimal place away. */
export function formatUnitCost(mills: number): string {
  safe(mills, "单位成本");
  const absolute = Math.abs(mills);
  const whole = Math.floor(absolute / 1000).toLocaleString("zh-CN");
  return `${mills < 0 ? "-" : ""}¥${whole}.${String(absolute % 1000).padStart(3, "0")}`;
}

/** Format integer fen without rounding away cents at the safe integer boundary. */
export function formatCny(cents: number): string {
  safe(cents, "金额");
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100).toLocaleString("zh-CN");
  return `${cents < 0 ? "-" : ""}¥${whole}.${String(absolute % 100).padStart(2, "0")}`;
}

export function profitRate(profit: number, revenue: number): number | null {
  safe(profit, "利润");
  integer(revenue, "营业收入", 0, Number.MAX_SAFE_INTEGER);
  return revenue === 0 ? null : (profit / revenue) * 100;
}

/** Check a calendar date independently of the host time zone and Date auto-rollover. */
export function validateDate(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000")
  ) {
    throw new Error("日期格式应为YYYY-MM-DD");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("日期不存在，请重新选择");
  }
  return value;
}

function shiftedDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validateRange(from: string, to: string): void {
  validateDate(from);
  validateDate(to);
  if (from > to) throw new Error("开始日期不能晚于结束日期");
}

export function dateToday(clock = new Date()): string {
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime()))
    throw new Error("当前时间无效");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(clock);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value;
  return validateDate(
    `${part("year")?.padStart(4, "0")}-${part("month")}-${part("day")}`,
  );
}

/** Current periods end on today. A business week starts on Monday. */
export function dateRange(
  period: "today" | "week" | "month",
  today: string,
): { from: string; to: string } {
  validateDate(today);
  if (period === "today") return { from: today, to: today };
  if (period === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (period !== "week") throw new Error("统计周期无效");
  const day = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const from = shiftedDate(today, -((day + 6) % 7));
  validateDate(from);
  return { from, to: today };
}

export function validateProduct<
  T extends Pick<Product, "name" | "category" | "costMills" | "priceCents">,
>(value: T): T {
  record(value, "商品");
  text(value.name, "商品名称", 120, true);
  text(value.category, "商品分类", 40);
  integer(value.costMills, "进货单价（厘）", 0, MAX_UNIT_MILLS);
  integer(value.priceCents, "销售单价（分）", 0, MAX_UNIT_CENTS);
  return value;
}

function validateItem(value: SaleItem): void {
  record(value, "销售明细");
  text(value.productId, "商品编号", 128, true);
  text(value.name, "商品名称", 120, true);
  text(value.category, "商品分类", 40);
  integer(value.quantity, "销售数量", 1, MAX_QUANTITY);
  integer(value.unitPriceCents, "实际售价（分）", 0, MAX_UNIT_CENTS);
  integer(value.unitCostMills, "单位成本（厘）", 0, MAX_UNIT_MILLS);
}

/**
 * One rounding boundary for every report: multiply a line's quantity by its
 * historical unit cost in li, then round half up to fen. Never round the unit
 * cost first or aggregate quantities across distinct sales before rounding.
 */
export function saleItemCostCents(
  item: Pick<SaleItem, "quantity" | "unitCostMills">,
): number {
  record(item, "销售明细");
  integer(item.quantity, "销售数量", 1, MAX_QUANTITY);
  integer(item.unitCostMills, "单位成本（厘）", 0, MAX_UNIT_MILLS);
  return safe(
    Number((BigInt(item.quantity) * BigInt(item.unitCostMills) + 5n) / 10n),
    "销售明细成本",
  );
}

export function saleTotals(sale: Pick<Sale, "items" | "extraIncomeCents">) {
  record(sale, "销售记录");
  if (!Array.isArray(sale.items) || sale.items.length === 0)
    throw new Error("请至少添加一项销售商品");
  const extraIncome = integer(
    sale.extraIncomeCents,
    "其他营业收入（分）",
    0,
    MAX_SALE_CENTS,
  );
  let productRevenue = 0;
  let cost = 0;
  for (const item of sale.items) {
    validateItem(item);
    productRevenue = safe(
      productRevenue + safe(item.quantity * item.unitPriceCents),
    );
    cost = safe(cost + saleItemCostCents(item));
  }
  const revenue = safe(productRevenue + extraIncome);
  if (revenue > MAX_SALE_CENTS || cost > MAX_SALE_CENTS) {
    throw new Error("每笔销售的收入和成本均不能超过100亿元");
  }
  return {
    productRevenue,
    extraIncome,
    revenue,
    cost,
    grossProfit: safe(revenue - cost),
  };
}

export function validateSale<
  T extends Pick<Sale, "businessDate" | "items" | "extraIncomeCents" | "note">,
>(value: T): T {
  record(value, "销售记录");
  validateDate(value.businessDate);
  text(value.note, "销售备注", 500);
  saleTotals(value);
  return value;
}

export function validateExpense<
  T extends Pick<Expense, "businessDate" | "category" | "amountCents" | "note">,
>(value: T): T {
  record(value, "经营费用");
  validateDate(value.businessDate);
  if (!EXPENSE_CATEGORIES.includes(value.category))
    throw new Error("请选择有效的费用类别");
  integer(value.amountCents, "费用金额（分）", 1, MAX_SALE_CENTS);
  text(value.note, "费用备注", 500);
  return value;
}

function activeSales(ledger: Ledger, from: string, to: string): Sale[] {
  return ledger.sales.filter((sale) => {
    if (sale.voidedAt != null) return false;
    validateDate(sale.businessDate);
    return sale.businessDate >= from && sale.businessDate <= to;
  });
}

function activeExpenses(ledger: Ledger, from: string, to: string): Expense[] {
  return ledger.expenses.filter((expense) => {
    if (expense.deletedAt != null) return false;
    validateDate(expense.businessDate);
    return expense.businessDate >= from && expense.businessDate <= to;
  });
}

export function summarize(ledger: Ledger, from: string, to: string) {
  validateRange(from, to);
  let revenue = 0;
  let cost = 0;
  let expenses = 0;
  let quantity = 0;
  const sales = activeSales(ledger, from, to);
  for (const sale of sales) {
    validateSale(sale);
    const totals = saleTotals(sale);
    revenue = safe(revenue + totals.revenue);
    cost = safe(cost + totals.cost);
    for (const item of sale.items)
      quantity = safe(quantity + item.quantity, "销售数量");
  }
  for (const expense of activeExpenses(ledger, from, to)) {
    validateExpense(expense);
    expenses = safe(expenses + expense.amountCents);
  }
  const grossProfit = safe(revenue - cost);
  const profit = safe(grossProfit - expenses);
  return {
    revenue,
    cost,
    grossProfit,
    expenses,
    profit,
    margin: profitRate(profit, revenue),
    quantity,
    saleCount: sales.length,
  };
}

export function trend(
  ledger: Ledger,
  from: string,
  to: string,
): { date: string; revenue: number; profit: number }[] {
  validateRange(from, to);
  const days =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  if (days > 3660) throw new Error("趋势图最多查看3660天，请缩小日期范围");
  const daily = new Map<
    string,
    { date: string; revenue: number; profit: number }
  >();
  for (let offset = 0; offset < days; offset++) {
    const date = shiftedDate(from, offset);
    daily.set(date, { date, revenue: 0, profit: 0 });
  }
  for (const sale of activeSales(ledger, from, to)) {
    validateSale(sale);
    const total = saleTotals(sale);
    const row = daily.get(sale.businessDate)!;
    row.revenue = safe(row.revenue + total.revenue);
    row.profit = safe(row.profit + total.grossProfit);
  }
  for (const expense of activeExpenses(ledger, from, to)) {
    validateExpense(expense);
    const row = daily.get(expense.businessDate)!;
    row.profit = safe(row.profit - expense.amountCents);
  }
  return [...daily.values()];
}

export type ProductRanking = {
  productId: string;
  name: string;
  category: string;
  quantity: number;
  revenue: number;
  cost: number;
  grossProfit: number;
};

/** Product contribution excludes order-level other income and operating expenses. */
export function rankProducts(
  ledger: Ledger,
  from: string,
  to: string,
): ProductRanking[] {
  validateRange(from, to);
  const rows = new Map<string, { row: ProductRanking; snapshotDate: string }>();
  for (const sale of activeSales(ledger, from, to)) {
    validateSale(sale);
    for (const item of sale.items) {
      const snapshotDate = `${sale.businessDate}|${sale.createdAt}|${sale.id}`;
      let entry = rows.get(item.productId);
      if (!entry) {
        entry = {
          snapshotDate,
          row: {
            productId: item.productId,
            name: item.name,
            category: item.category,
            quantity: 0,
            revenue: 0,
            cost: 0,
            grossProfit: 0,
          },
        };
        rows.set(item.productId, entry);
      }
      const { row } = entry;
      if (snapshotDate >= entry.snapshotDate) {
        row.name = item.name;
        row.category = item.category;
        entry.snapshotDate = snapshotDate;
      }
      row.quantity = safe(row.quantity + item.quantity, "商品销量");
      row.revenue = safe(
        row.revenue + safe(item.quantity * item.unitPriceCents),
      );
      row.cost = safe(row.cost + saleItemCostCents(item));
      row.grossProfit = safe(row.revenue - row.cost);
    }
  }
  return [...rows.values()]
    .map(({ row }) => row)
    .sort(
      (a, b) =>
        b.grossProfit - a.grossProfit ||
        b.revenue - a.revenue ||
        a.name.localeCompare(b.name, "zh-CN"),
    );
}
