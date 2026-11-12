import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Ledger,
  Product,
  Sale,
  SaleItem,
  Expense,
  InventoryBalance,
  InventoryReceipt,
} from "./domain";
import { MAX_UNIT_MILLS } from "./domain.ts";
import {
  validateInventoryQuantity,
  validateInventoryReceipt,
} from "./inventory.ts";
import type { InventoryReceiptDraft } from "./inventory.ts";

type Row = Record<string, unknown>;
export type Shop = { id: string; name: string; ownerId: string };
export type ProductDraft = Pick<
  Product,
  "name" | "category" | "costMills" | "priceCents"
>;
export type SaleDraft = Pick<
  Sale,
  "businessDate" | "items" | "extraIncomeCents" | "note"
> & { occurredAt?: string; salesOnly?: boolean };
export type ExpenseDraft = Pick<
  Expense,
  "businessDate" | "category" | "amountCents" | "note"
>;

function amount(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("收到无效金额，请停止记账并刷新页面。");
  return n;
}
function str(value: unknown) {
  return typeof value === "string" ? value : "";
}
function nullable(value: unknown) {
  return value == null ? null : str(value);
}
function unitCostMills(row: Row, millsColumn: string, legacyColumn: string) {
  // A missing precision column can be an old response. An invalid present
  // column must fail closed rather than conceal corruption with a fallback.
  const mills = Object.prototype.hasOwnProperty.call(row, millsColumn)
    ? amount(row[millsColumn])
    : amount(row[legacyColumn]) * 10;
  if (!Number.isSafeInteger(mills) || mills > MAX_UNIT_MILLS)
    throw new Error("收到无效单位成本，请停止记账并刷新页面。");
  return mills;
}
function product(row: Row): Product {
  return {
    id: str(row.id),
    name: str(row.name),
    category: str(row.category),
    costMills: unitCostMills(
      row,
      "purchase_unit_cost_mills",
      "purchase_unit_cost_cents",
    ),
    priceCents: amount(row.sale_unit_price_cents),
    deletedAt: nullable(row.deleted_at),
    updatedAt: str(row.updated_at),
  };
}
function item(row: Row): SaleItem {
  return {
    productId: str(row.product_id),
    name: str(row.product_name_snapshot),
    category: str(row.category_snapshot),
    quantity: amount(row.quantity),
    unitPriceCents: amount(row.unit_sale_price_cents),
    unitCostMills: unitCostMills(row, "unit_cost_mills", "unit_cost_cents"),
  };
}
function sale(row: Row, items: SaleItem[]): Sale {
  return {
    id: str(row.id),
    businessDate: str(row.business_date),
    items,
    extraIncomeCents: amount(row.extra_income_cents),
    note: str(row.note),
    version: amount(row.version),
    voidedAt: nullable(row.voided_at),
    createdAt: str(row.created_at),
    ...(row.occurred_at == null ? {} : { occurredAt: str(row.occurred_at) }),
  };
}
function expense(row: Row): Expense {
  return {
    id: str(row.id),
    businessDate: str(row.business_date),
    category: str(row.category) as Expense["category"],
    amountCents: amount(row.amount_cents),
    note: str(row.note),
    deletedAt: nullable(row.deleted_at),
    createdAt: str(row.created_at),
  };
}

function inventoryBalance(row: Row): InventoryBalance {
  return {
    productId: str(row.product_id),
    quantity: amount(row.quantity),
    initializedAt: str(row.initialized_at),
    countedAt: str(row.counted_at),
  };
}
function inventoryReceipt(row: Row): InventoryReceipt {
  return {
    id: str(row.id),
    productId: str(row.product_id),
    businessDate: str(row.business_date),
    quantity: amount(row.quantity),
    unitCostMills: amount(row.unit_cost_mills),
    note: str(row.note),
    createdAt: str(row.created_at),
  };
}

export async function countInventory(
  client: SupabaseClient,
  productId: string,
  quantity: number,
  requestId: string,
  expectedQuantity: number | null,
): Promise<void> {
  validateInventoryQuantity(quantity);
  const { error } = await client.rpc("count_inventory", {
    p_product_id: productId,
    p_quantity: quantity,
    p_request_id: requestId,
    p_expected_quantity: expectedQuantity,
  });
  if (error) throw error;
}

export async function receiveInventory(
  client: SupabaseClient,
  draft: InventoryReceiptDraft,
  id: string,
): Promise<InventoryReceipt> {
  validateInventoryReceipt(draft);
  const { data, error } = await client.rpc("receive_inventory", {
    p_id: id,
    p_product_id: draft.productId,
    p_business_date: draft.businessDate,
    p_quantity: draft.quantity,
    p_unit_cost_mills: draft.unitCostMills,
    p_note: draft.note,
  });
  if (error) throw error;
  return inventoryReceipt(data as Row);
}

// 按不可变 UUID 游标翻页，避免其他设备增删前面的记录时让 offset 重复或跳行。
// 这不是跨页数据库快照：游标前的新记录可能下次刷新才出现；任何页失败则整次加载失败。
async function rows(
  client: SupabaseClient,
  table: string,
  shopId: string,
  selection = "*",
): Promise<Row[]> {
  const pageSize = 500;
  const result: Row[] = [];
  const seen = new Set<string>();
  let afterId: string | undefined;
  for (;;) {
    let query = client
      .from(table)
      .select(selection)
      .eq("shop_id", shopId)
      .order("id", { ascending: true });
    if (afterId !== undefined) query = query.gt("id", afterId);
    const { data, error } = await query.limit(pageSize);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("账本加载不完整，请刷新后再试。");
    const page = data as unknown as Row[];
    if (page.length === 0) return result;
    let nextId = afterId;
    for (const row of page) {
      const id = str(row.id);
      if (!id) throw new Error("账本记录缺少编号，请刷新后再试。");
      if (!seen.has(id)) {
        seen.add(id);
        result.push(row);
      }
      if (nextId === undefined || id > nextId) nextId = id;
    }
    // 防御重复响应：既不能重复计算利润，也不能在不前进的页上无限请求。
    if (nextId === afterId)
      throw new Error("账本分页读取未前进，请刷新后再试。");
    afterId = nextId;
    if (page.length < pageSize) return result;
  }
}

export async function findShop(
  client: SupabaseClient,
  ownerId: string,
): Promise<Shop | null> {
  const { data, error } = await client
    .from("shops")
    .select("id,name,owner_id")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, name: data.name, ownerId: data.owner_id } : null;
}
export async function createShop(
  client: SupabaseClient,
  ownerId: string,
  name: string,
): Promise<Shop> {
  const { data, error } = await client
    .from("shops")
    .insert({
      owner_id: ownerId,
      name: name.trim(),
      currency: "CNY",
      timezone: "Asia/Shanghai",
    })
    .select("id,name,owner_id")
    .single();
  if (error) throw error;
  return { id: data.id, name: data.name, ownerId: data.owner_id };
}
export async function loadInventory(
  client: SupabaseClient,
  shopId: string,
): Promise<InventoryBalance[]> {
  return (await rows(client, "inventory_levels", shopId)).map(inventoryBalance);
}

export async function loadLedger(
  client: SupabaseClient,
  shopId: string,
): Promise<Ledger> {
  const [products, sales, expenses, inventory, receipts] = await Promise.all([
    rows(client, "products", shopId),
    rows(client, "sales", shopId, "*,sale_items(*)"),
    rows(client, "expenses", shopId),
    rows(client, "inventory_levels", shopId),
    rows(client, "inventory_receipts", shopId),
  ]);
  return {
    products: products.map(product),
    sales: sales.map(nestedSale),
    expenses: expenses.map(expense),
    inventory: inventory.map(inventoryBalance),
    inventoryReceipts: receipts.map(inventoryReceipt),
  };
}
function nestedSale(row: Row): Sale {
  if (!Array.isArray(row.sale_items))
    throw new Error("销售明细加载不完整，请刷新后再试。");
  return sale(
    row,
    (row.sale_items as Row[])
      .sort((a, b) => amount(a.line_number) - amount(b.line_number))
      .map(item),
  );
}
export async function putProduct(
  client: SupabaseClient,
  shopId: string,
  draft: ProductDraft,
  id: string,
  existing?: Product,
) {
  const fields = {
    name: draft.name,
    category: draft.category,
    purchase_unit_cost_mills: draft.costMills,
    sale_unit_price_cents: draft.priceCents,
  };
  const query = existing
    ? client
        .from("products")
        .update(fields)
        .eq("shop_id", shopId)
        .eq("id", id)
        .eq("updated_at", existing.updatedAt)
    : client.from("products").insert({ id, shop_id: shopId, ...fields });
  const { data, error } = await query.select().single();
  if (error) {
    if (!existing && error.code === "23505") {
      const prior = await client
        .from("products")
        .select()
        .eq("shop_id", shopId)
        .eq("id", id)
        .single();
      if (
        !prior.error &&
        prior.data &&
        prior.data.name === draft.name &&
        prior.data.category === draft.category &&
        unitCostMills(
          prior.data,
          "purchase_unit_cost_mills",
          "purchase_unit_cost_cents",
        ) === draft.costMills &&
        amount(prior.data.sale_unit_price_cents) === draft.priceCents &&
        prior.data.deleted_at === null
      )
        return product(prior.data);
    }
    throw error;
  }
  return product(data);
}
export async function setProductDeleted(
  client: SupabaseClient,
  shopId: string,
  current: Product,
  deleted: boolean,
) {
  const { data, error } = await client
    .from("products")
    .update({ deleted_at: deleted ? new Date().toISOString() : null })
    .eq("shop_id", shopId)
    .eq("id", current.id)
    .eq("updated_at", current.updatedAt)
    .select()
    .single();
  if (error) throw error;
  return product(data);
}
export async function putSale(
  client: SupabaseClient,
  shopId: string,
  draft: SaleDraft,
  id: string,
  requestId: string,
  expectedVersion?: number,
): Promise<Sale> {
  let originalRequestId = requestId;
  if (expectedVersion !== undefined) {
    const { data, error } = await client
      .from("sales")
      .select("request_id")
      .eq("shop_id", shopId)
      .eq("id", id)
      .single();
    if (error) throw error;
    originalRequestId = data.request_id;
  }
  const { data, error } = await client.rpc("save_sale", {
    p_id: id,
    p_business_date: draft.businessDate,
    p_extra_income_cents: draft.extraIncomeCents,
    p_note: draft.note,
    p_items: draft.items,
    p_expected_version: expectedVersion ?? null,
    p_request_id: originalRequestId,
    ...(draft.occurredAt === undefined
      ? {}
      : { p_occurred_at: draft.occurredAt }),
    ...(draft.salesOnly === true ? { p_sales_only: true } : {}),
  });
  if (error) throw error;
  // 重试返回原始单据，不能把重试草稿伪装成数据库结果。
  const head = data as Row;
  const snapshot = await client
    .from("sales")
    .select("*,sale_items(*)")
    .eq("shop_id", shopId)
    .eq("id", str(head.id))
    .single();
  if (snapshot.error) throw snapshot.error;
  return nestedSale(snapshot.data);
}
export async function removeSale(
  client: SupabaseClient,
  id: string,
  expectedVersion: number,
): Promise<Row> {
  const { data, error } = await client.rpc("void_sale", {
    p_id: id,
    p_expected_version: expectedVersion,
  });
  if (error) throw error;
  return data as Row;
}
export async function putExpense(
  client: SupabaseClient,
  shopId: string,
  draft: ExpenseDraft,
  id: string,
  existing = false,
): Promise<Expense> {
  const fields = {
    business_date: draft.businessDate,
    category: draft.category,
    amount_cents: draft.amountCents,
    note: draft.note,
  };
  const query = existing
    ? client
        .from("expenses")
        .update(fields)
        .eq("shop_id", shopId)
        .eq("id", id)
        .is("deleted_at", null)
    : client.from("expenses").insert({ id, shop_id: shopId, ...fields });
  const { data, error } = await query.select().single();
  if (error) {
    if (!existing && error.code === "23505") {
      const prior = await client
        .from("expenses")
        .select()
        .eq("shop_id", shopId)
        .eq("id", id)
        .single();
      if (
        !prior.error &&
        prior.data &&
        prior.data.business_date === draft.businessDate &&
        prior.data.category === draft.category &&
        amount(prior.data.amount_cents) === draft.amountCents &&
        (prior.data.note ?? "") === draft.note &&
        prior.data.deleted_at === null
      )
        return expense(prior.data);
    }
    throw error;
  }
  return expense(data);
}
export async function removeExpense(
  client: SupabaseClient,
  shopId: string,
  id: string,
): Promise<Expense> {
  const { data, error } = await client
    .from("expenses")
    .update({ deleted_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();
  if (error) throw error;
  return expense(data);
}
