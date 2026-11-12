import { MAX_QUANTITY, MAX_UNIT_MILLS, validateDate } from "./domain.ts";
import type { InventoryReceipt, Ledger } from "./domain.ts";

export type InventoryReceiptDraft = Pick<
  InventoryReceipt,
  "productId" | "businessDate" | "quantity" | "unitCostMills" | "note"
>;
export type InventoryWarning = {
  productId: string;
  name: string;
  quantity: number | null;
  sold7Days: number;
  dailySales: number;
  daysRemaining: number | null;
  status: "unknown" | "no_sales" | "slow" | "normal" | "out_of_stock";
};

export function validateInventoryQuantity(
  quantity: number,
  allowZero = true,
): number {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < (allowZero ? 0 : 1) ||
    quantity > MAX_QUANTITY
  )
    throw new Error(
      `库存数量必须是${allowZero ? 0 : 1}到${MAX_QUANTITY}之间的整数`,
    );
  return quantity;
}

export function validateInventoryReceipt<T extends InventoryReceiptDraft>(
  draft: T,
): T {
  validateDate(draft.businessDate);
  validateInventoryQuantity(draft.quantity, false);
  if (
    !draft.productId ||
    !Number.isSafeInteger(draft.unitCostMills) ||
    draft.unitCostMills < 0 ||
    draft.unitCostMills > MAX_UNIT_MILLS
  )
    throw new Error("请选择商品并填写有效的三位小数进货单价");
  if (typeof draft.note !== "string" || draft.note.length > 500)
    throw new Error("进货备注最多500个字符");
  return draft;
}

/** Seven calendar days include today; a projection is not a promise of future sales. */
export function inventoryWarnings(
  ledger: Ledger,
  today: string,
  thresholdDays = 30,
): InventoryWarning[] {
  validateDate(today);
  if (!Number.isFinite(thresholdDays) || thresholdDays <= 0)
    throw new Error("预警天数必须大于0");
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 6);
  const from = start.toISOString().slice(0, 10);
  const sold = new Map<string, number>();
  for (const sale of ledger.sales) {
    if (
      sale.voidedAt != null ||
      sale.businessDate < from ||
      sale.businessDate > today
    )
      continue;
    for (const item of sale.items)
      sold.set(item.productId, (sold.get(item.productId) ?? 0) + item.quantity);
  }
  const balances = new Map(
    (ledger.inventory ?? []).map((row) => [row.productId, row.quantity]),
  );
  return ledger.products
    .filter((p) => p.deletedAt == null)
    .map((p) => {
      const quantity = balances.get(p.id) ?? null;
      const sold7Days = sold.get(p.id) ?? 0;
      const dailySales = sold7Days / 7;
      const daysRemaining =
        quantity == null || sold7Days === 0 ? null : (quantity * 7) / sold7Days;
      const status =
        quantity == null
          ? "unknown"
          : quantity === 0
            ? "out_of_stock"
            : sold7Days === 0
              ? "no_sales"
              : daysRemaining! > thresholdDays
                ? "slow"
                : "normal";
      return {
        productId: p.id,
        name: p.name,
        quantity,
        sold7Days,
        dailySales,
        daysRemaining,
        status,
      };
    });
}
