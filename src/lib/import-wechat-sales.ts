import {
  dateToday,
  saleTotals,
  validateDate,
  validateProduct,
  validateSale,
  type Ledger,
  type Product,
  type Sale,
} from "./domain.ts";
import type { ProductDraft, SaleDraft } from "./cloud-repository.ts";
import type {
  WechatImportInput,
  WechatImportResult,
  WechatProductBinding,
  WechatReceipt,
} from "./wechat-import-types.ts";
import { wechatProductId, wechatSaleId } from "./wechat-receipts.ts";

/** The caller binds every repository operation to one already-owned shop. */
export type WechatImportDependencies = {
  shopId: string;
  ledger: Ledger;
  isCurrent: () => boolean;
  createProduct: (draft: ProductDraft, id: string) => Promise<Product>;
  createSale: (draft: SaleDraft, id: string) => Promise<Sale>;
  loadLedger: () => Promise<Ledger>;
  onLedger?: (ledger: Ledger) => void;
};

export type WechatImportOutcome = {
  result: WechatImportResult;
  /** Never return the former account's ledger after an identity change. */
  ledger: Ledger | null;
  scopeChanged: boolean;
};

type ProductPlan = {
  binding: WechatProductBinding;
  id: string;
  existing?: Product;
};
type ReceiptPlan = { receipt: WechatReceipt; id: string };

function checkedText(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > max
  )
    throw new Error(`${label}格式无效，请重新选择小票文件。`);
  return value;
}

function checkedReceipt(receipt: WechatReceipt, today: string) {
  if (
    !receipt ||
    !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
    !Number.isSafeInteger(receipt.sourceRow) ||
    receipt.sourceRow < 1 ||
    !Array.isArray(receipt.issues) ||
    receipt.issues.length !== 0 ||
    receipt.refundMarked !== false ||
    !Array.isArray(receipt.items) ||
    receipt.items.length < 1 ||
    receipt.items.length > 100
  )
    throw new Error("存在未核对、退款或格式异常的小票，请先排除后再导入。");
  validateDate(receipt.businessDate);
  if (receipt.businessDate > today) throw new Error("销售日期不能晚于今天。");
  if (
    typeof receipt.paidAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(
      receipt.paidAt,
    ) ||
    receipt.paidAt.slice(0, 10) !== receipt.businessDate
  )
    throw new Error("小票时间与销售日期不一致，请先核对。");
  const total = saleTotals({
    items: receipt.items.map((item) => ({
      productId: "preflight",
      name: checkedText(item.name, "小票商品名称", 120),
      category: "微信导入",
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      unitCostMills: 0,
    })),
    extraIncomeCents: receipt.extraIncomeCents,
  });
  if (
    !Number.isSafeInteger(receipt.totalCents) ||
    receipt.totalCents <= 0 ||
    total.revenue !== receipt.totalCents
  )
    throw new Error("小票明细金额与实收合计不一致，请先核对。");
}

function productMatches(product: Product | undefined, sourceName: string) {
  return (
    product !== undefined &&
    product.deletedAt === null &&
    product.name === sourceName
  );
}

function upsert<T extends { id: string }>(rows: T[], value: T): T[] {
  return rows.some((row) => row.id === value.id)
    ? rows.map((row) => (row.id === value.id ? value : row))
    : [...rows, value];
}

function saleFailureMessage(cause: unknown): string {
  // Expose only the known stock validation message, never arbitrary API details.
  const error =
    cause && typeof cause === "object"
      ? (cause as { code?: unknown; message?: unknown })
      : {};
  if (
    error.code === "23514" &&
    typeof error.message === "string" &&
    /^库存不足或数量超出上限：[^\u0000-\u001f\u007f]{1,120}。请核对进货和实际销售数量$/u.test(
      error.message,
    )
  )
    return `${error.message}。本条尚未导入，请先核对“库存与进货”，再重新导入。`;
  return "本条保存未完成，已停止后续导入；刷新后可重试。";
}

/**
 * Create-only import. Stable identities ignore reviewed costs and file names.
 * The existing save_sale RPC arbitrates simultaneous imports; this function
 * never sends an expected version and never updates an existing product/sale.
 */
export async function importWechatSales(
  input: WechatImportInput,
  deps: WechatImportDependencies,
): Promise<WechatImportOutcome> {
  if (!deps.isCurrent())
    throw new Error("账号状态已变化，请重新打开导入页面。");
  if (input.confirmedPaidNoRefund !== true)
    throw new Error("请先确认所选小票均已收款且没有退款。");
  if (input.salesOnly !== undefined && typeof input.salesOnly !== "boolean")
    throw new Error("请重新选择小票的入账方式。");
  const merchant = checkedText(input.merchantName, "来源商家", 120);
  if (!Array.isArray(input.receipts) || !input.receipts.length)
    throw new Error("请先选择需要导入的小票。");
  if (!Array.isArray(input.products)) throw new Error("商品对应关系无效。");

  // Complete all validation and deterministic ID work before the first write.
  const today = dateToday();
  const receiptPlans: ReceiptPlan[] = [];
  for (const receipt of input.receipts) {
    checkedReceipt(receipt, today);
    receiptPlans.push({
      receipt,
      id: await wechatSaleId(deps.shopId, receipt.fingerprint),
    });
  }
  const existingSaleIds = new Set(deps.ledger.sales.map((sale) => sale.id));
  const neededNames = new Set(
    receiptPlans
      .filter((plan) => !existingSaleIds.has(plan.id))
      .flatMap((plan) => plan.receipt.items.map((item) => item.name)),
  );
  const bindings = new Map<string, WechatProductBinding>();
  for (const binding of input.products) {
    const name = checkedText(binding.sourceName, "来源商品名称", 120);
    if (bindings.has(name))
      throw new Error("同一个来源商品只能设置一项对应关系。");
    validateProduct({
      name,
      category: "微信导入",
      costMills: binding.costMills,
      priceCents: binding.priceCents,
    });
    bindings.set(name, { ...binding });
  }
  const productPlans = new Map<string, ProductPlan>();
  for (const name of neededNames) {
    const binding = bindings.get(name);
    if (!binding) throw new Error(`请先核对「${name}」的对应商品与成本。`);
    const id =
      binding.productId ?? (await wechatProductId(deps.shopId, merchant, name));
    const existing = deps.ledger.products.find((product) => product.id === id);
    if (binding.productId) {
      if (!existing || existing.deletedAt !== null)
        throw new Error("所选商品不存在或已停用，请重新核对商品对应关系。");
    } else if (existing && !productMatches(existing, name)) {
      throw new Error(
        "来源商品对应的历史商品已停用或名称已更改，请手动选择商品。",
      );
    }
    productPlans.set(name, { binding, id, existing });
  }
  const drafts = new Map<string, SaleDraft>();
  for (const { receipt, id } of receiptPlans) {
    if (existingSaleIds.has(id)) continue;
    const draft: SaleDraft = {
      businessDate: receipt.businessDate,
      // The receipt uses China time. Preserve the actual payment instant so
      // late imports before a stock count do not deduct the count a second time.
      occurredAt: new Date(
        `${receipt.paidAt.replace(" ", "T")}+08:00`,
      ).toISOString(),
      ...(input.salesOnly === true ? { salesOnly: true } : {}),
      items: receipt.items.map((item) => {
        const plan = productPlans.get(item.name)!;
        return {
          productId: plan.id,
          name: plan.existing?.name ?? item.name,
          category: plan.existing?.category ?? "微信导入",
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          unitCostMills: plan.binding.costMills,
        };
      }),
      extraIncomeCents: receipt.extraIncomeCents,
      note: `微信小票 · ${merchant} · ${receipt.paidAt} · 指纹:${receipt.fingerprint}`,
    };
    validateSale(draft);
    drafts.set(id, draft);
  }
  if (!deps.isCurrent())
    throw new Error("账号状态已变化，请重新打开导入页面。");

  let ledger = deps.ledger;
  let refreshedAfterError = false;
  const result: WechatImportResult = {
    imported: 0,
    skipped: 0,
    createdProducts: 0,
    failed: 0,
    errors: [],
  };
  const outcome = (): WechatImportOutcome => ({
    result,
    ledger: deps.isCurrent() ? ledger : null,
    scopeChanged: !deps.isCurrent(),
  });
  const publish = () => {
    if (deps.isCurrent()) deps.onLedger?.(ledger);
  };
  const refreshAfterError = async () => {
    if (refreshedAfterError || !deps.isCurrent()) return;
    refreshedAfterError = true;
    try {
      const refreshed = await deps.loadLedger();
      if (!deps.isCurrent()) return;
      ledger = refreshed;
      publish();
    } catch {
      // Keep acknowledged writes visible. Do not retry an uncertain write.
    }
  };
  const stop = (index: number, message: string) => {
    for (const { receipt } of receiptPlans.slice(index)) {
      result.failed += 1;
      result.errors.push({
        sourceRow: receipt.sourceRow,
        paidAt: receipt.paidAt,
        message:
          result.errors.length === 0
            ? message
            : "上一条保存未完成，本条尚未导入；刷新后可重新导入。",
      });
    }
  };

  for (let index = 0; index < receiptPlans.length; index += 1) {
    if (!deps.isCurrent()) return outcome();
    const { receipt, id } = receiptPlans[index];
    // Includes voided records, and successful earlier rows in this batch.
    if (ledger.sales.some((sale) => sale.id === id)) {
      result.skipped += 1;
      continue;
    }
    for (const item of receipt.items) {
      if (!deps.isCurrent()) return outcome();
      const plan = productPlans.get(item.name)!;
      const currentProduct = ledger.products.find(
        (product) => product.id === plan.id,
      );
      if (currentProduct) {
        if (
          currentProduct.deletedAt !== null ||
          (!plan.binding.productId && currentProduct.name !== item.name)
        ) {
          stop(index, "对应商品已停用或名称发生变化，请重新核对后导入。");
          return outcome();
        }
        continue;
      }
      if (plan.binding.productId) {
        stop(index, "所选商品已不在当前账本中，请刷新后重新核对。");
        return outcome();
      }
      try {
        if (!deps.isCurrent()) return outcome();
        const created = await deps.createProduct(
          {
            name: item.name,
            category: "微信导入",
            costMills: plan.binding.costMills,
            priceCents: plan.binding.priceCents,
          },
          plan.id,
        );
        if (!deps.isCurrent()) return outcome();
        if (created.id !== plan.id || !productMatches(created, item.name))
          throw new Error("Unexpected product identity");
        ledger = { ...ledger, products: upsert(ledger.products, created) };
        result.createdProducts += 1;
        publish();
      } catch {
        await refreshAfterError();
        if (!deps.isCurrent()) return outcome();
        const found = ledger.products.find((product) => product.id === plan.id);
        if (!productMatches(found, item.name)) {
          stop(index, "商品保存未完成，已停止后续导入；刷新后可重试。");
          return outcome();
        }
      }
    }
    if (!deps.isCurrent()) return outcome();
    try {
      const saved = await deps.createSale(drafts.get(id)!, id);
      if (!deps.isCurrent()) return outcome();
      if (saved.id !== id) throw new Error("Unexpected sale identity");
      ledger = { ...ledger, sales: upsert(ledger.sales, saved) };
      result.imported += 1;
      publish();
    } catch (cause) {
      await refreshAfterError();
      if (!deps.isCurrent()) return outcome();
      if (ledger.sales.some((sale) => sale.id === id)) {
        result.skipped += 1;
        continue;
      }
      stop(index, saleFailureMessage(cause));
      return outcome();
    }
  }
  return outcome();
}
