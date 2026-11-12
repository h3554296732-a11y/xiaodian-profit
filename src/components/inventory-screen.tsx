"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Boxes, ClipboardCheck, Package, Plus, Search } from "lucide-react";
import { useLedger } from "@/components/ledger-provider";
import { dateToday, formatUnitCost, parseUnitCost } from "@/lib/domain";
import {
  inventoryWarnings,
  validateInventoryQuantity,
  validateInventoryReceipt,
  type InventoryWarning,
} from "@/lib/inventory";
import {
  EmptyRecords,
  FormDialog,
  FormError,
  LoadingRecords,
  actionClass,
  errorMessage,
  inputClass,
  labelClass,
} from "./form-dialog";

const blankCount = {
  productId: "",
  quantity: "",
  expectedQuantity: null as number | null,
};
const blankReceipt = () => ({
  productId: "",
  businessDate: dateToday(),
  quantity: "",
  cost: "",
  note: "",
});

function quantityInput(value: string, allowZero: boolean) {
  if (!/^\d+$/.test(value.trim()))
    throw new Error("数量请填写整数，不要填写小数或负数。");
  return validateInventoryQuantity(Number(value.trim()), allowZero);
}

const statusDetails: Record<
  InventoryWarning["status"],
  { label: string; note: string; color: string }
> = {
  unknown: {
    label: "待录入",
    note: "先盘点实际剩余数量，再开始自动扣库存。",
    color: "bg-stone-100 text-stone-700",
  },
  no_sales: {
    label: "近7天无销量",
    note: "暂时无法估算售罄天数，建议先观察、暂缓补货。",
    color: "bg-amber-50 text-amber-900",
  },
  slow: {
    label: "慢销，暂缓补货",
    note: "现有库存预计可售较久，先消化库存再考虑补货。",
    color: "bg-amber-50 text-amber-900",
  },
  normal: {
    label: "按需补货",
    note: "结合实际销量和到货时间，安排下一次进货。",
    color: "bg-emerald-50 text-emerald-900",
  },
  out_of_stock: {
    label: "缺货提醒",
    note: "当前库存为零，请核对存货并及时补货。",
    color: "bg-red-50 text-red-800",
  },
};

function daysLabel(value: number | null) {
  return value === null
    ? "暂无法估算"
    : `约 ${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 天`;
}

export default function InventoryScreen() {
  const { user, shop } = useLedger();
  return (
    <InventoryContent
      key={`${user?.id ?? "signed-out"}:${shop?.id ?? "no-shop"}`}
    />
  );
}

function InventoryContent() {
  const {
    data,
    ready,
    authReady,
    busy,
    loading,
    user,
    shop,
    error: ledgerError,
    countInventory,
    receiveInventory,
  } = useLedger();
  const [today, setToday] = useState(dateToday);
  const [threshold, setThreshold] = useState(30);
  const [search, setSearch] = useState("");
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [countForm, setCountForm] = useState(blankCount);
  const [receiptForm, setReceiptForm] = useState(blankReceipt);
  const [countError, setCountError] = useState("");
  const [receiptError, setReceiptError] = useState("");
  const [saving, setSaving] = useState<"count" | "receipt" | null>(null);
  const submitting = useRef(false);
  const countRequest = useRef<{ key: string; id: string } | null>(null);
  const receiptRequest = useRef<{ key: string; id: string } | null>(null);
  const canWrite =
    ready && authReady && !!user && !!shop && !loading && !ledgerError;
  const locked = !canWrite || busy || saving !== null;
  useEffect(() => {
    const update = () => setToday(dateToday());
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, []);

  const warnings = inventoryWarnings(data, today, threshold);
  const visible = warnings.filter(
    (item) =>
      item.name
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()) &&
      (!onlyWarnings || item.status !== "normal"),
  );
  const unknownCount = warnings.filter(
    (item) => item.status === "unknown",
  ).length;
  const stockoutCount = warnings.filter(
    (item) => item.status === "out_of_stock",
  ).length;
  const slowCount = warnings.filter(
    (item) => item.status === "slow" || item.status === "no_sales",
  ).length;
  const productById = new Map(
    data.products.map((product) => [product.id, product]),
  );
  const activeProducts = data.products.filter((product) => !product.deletedAt);
  const inventoryByProduct = new Map(
    (data.inventory ?? []).map((row) => [row.productId, row]),
  );
  const initializedProducts = activeProducts.filter((product) =>
    inventoryByProduct.has(product.id),
  );
  const receiptBalance = inventoryByProduct.get(receiptForm.productId);
  const receipts = [...(data.inventoryReceipts ?? [])].sort(
    (a, b) =>
      b.businessDate.localeCompare(a.businessDate) ||
      b.createdAt.localeCompare(a.createdAt),
  );

  function selectCountProduct(productId: string) {
    const balance = inventoryByProduct.get(productId);
    setCountForm({
      productId,
      quantity: balance ? String(balance.quantity) : "",
      expectedQuantity: balance?.quantity ?? null,
    });
    setCountError("");
  }
  function openCount(productId = "") {
    if (locked) return;
    selectCountProduct(productId);
    setCountOpen(true);
  }
  function selectReceiptProduct(productId: string) {
    const product = productById.get(productId);
    setReceiptForm((current) => ({
      ...current,
      productId,
      cost: product ? (product.costMills / 1000).toFixed(3) : "",
    }));
    setReceiptError("");
  }
  function openReceipt() {
    if (locked) return;
    setReceiptError("");
    setReceiptOpen(true);
  }
  async function saveCount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy) return;
    setCountError("");
    if (!canWrite) {
      setCountError("账本尚未成功加载，请重新登录或刷新后再保存。");
      return;
    }
    submitting.current = true;
    setSaving("count");
    try {
      if (!activeProducts.some((product) => product.id === countForm.productId))
        throw new Error("请选择一件在售商品。");
      const quantity = quantityInput(countForm.quantity, true);
      const key = JSON.stringify([
        countForm.productId,
        quantity,
        countForm.expectedQuantity,
      ]);
      if (countRequest.current?.key !== key)
        countRequest.current = { key, id: crypto.randomUUID() };
      await countInventory(
        countForm.productId,
        quantity,
        countRequest.current.id,
        countForm.expectedQuantity,
      );
      countRequest.current = null;
      setCountOpen(false);
      setCountForm(blankCount);
    } catch (cause) {
      setCountError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setSaving(null);
    }
  }
  async function saveReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy) return;
    setReceiptError("");
    if (!canWrite) {
      setReceiptError("账本尚未成功加载，请重新登录或刷新后再保存。");
      return;
    }
    submitting.current = true;
    setSaving("receipt");
    try {
      if (
        !initializedProducts.some(
          (product) => product.id === receiptForm.productId,
        )
      )
        throw new Error("请先盘点这件商品，再记进货。");
      const draft = validateInventoryReceipt({
        productId: receiptForm.productId,
        businessDate: receiptForm.businessDate,
        quantity: quantityInput(receiptForm.quantity, false),
        unitCostMills: parseUnitCost(receiptForm.cost),
        note: receiptForm.note.trim(),
      });
      if (draft.businessDate > dateToday())
        throw new Error("进货日期不能晚于今天。");
      if (
        receiptBalance &&
        draft.businessDate < dateToday(new Date(receiptBalance.countedAt))
      )
        throw new Error(
          "进货日期不能早于最近盘点日；盘点前到货的数量已包含在盘点里。",
        );
      const key = JSON.stringify(draft);
      if (receiptRequest.current?.key !== key)
        receiptRequest.current = { key, id: crypto.randomUUID() };
      await receiveInventory(draft, receiptRequest.current.id);
      receiptRequest.current = null;
      setReceiptOpen(false);
      setReceiptForm(blankReceipt());
    } catch (cause) {
      setReceiptError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setSaving(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="page-heading">
        <div>
          <p className="eyebrow">少压货，心里更有数</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            库存与进货
          </h1>
          <p className="muted mt-3">
            把实际存货记下来，看看哪些该补、哪些可以缓一缓。
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="button button-secondary min-h-11"
            disabled={locked || !activeProducts.length}
            onClick={() => openCount()}
          >
            <ClipboardCheck size={17} aria-hidden="true" />
            盘点库存
          </button>
          <button
            type="button"
            className="button button-primary min-h-11"
            disabled={locked || !initializedProducts.length}
            onClick={openReceipt}
          >
            <Plus size={17} aria-hidden="true" />
            记一笔进货
          </button>
        </div>
      </div>
      {!ready || loading ? (
        <LoadingRecords />
      ) : (
        <>
          <section
            className="panel space-y-5"
            aria-labelledby="inventory-title"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <Boxes
                  size={22}
                  className="mt-0.5 text-emerald-800"
                  aria-hidden="true"
                />
                <div>
                  <h2 id="inventory-title" className="font-semibold">
                    在售商品库存
                  </h2>
                  <p className="mt-1 text-xs leading-6 text-stone-500">
                    {stockoutCount} 件缺货 · {slowCount} 件建议暂缓补货 ·{" "}
                    {unknownCount} 件待录入
                  </p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-stone-600">
                库存可售超过
                <select
                  className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 text-sm"
                  value={threshold}
                  onChange={(event) => setThreshold(Number(event.target.value))}
                >
                  {[7, 14, 30, 60, 90].map((days) => (
                    <option key={days} value={days}>
                      {days}天
                    </option>
                  ))}
                </select>
                提醒慢销
              </label>
            </div>
            <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto]">
              <label className={labelClass}>
                <span className="sr-only">搜索库存商品</span>
                <span className="relative block">
                  <Search
                    size={17}
                    className="pointer-events-none absolute left-3 top-3.5 text-stone-400"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    className={`${inputClass} pl-10`}
                    placeholder="搜索商品名称"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </span>
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-stone-600">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-emerald-800"
                  checked={onlyWarnings}
                  onChange={(event) => setOnlyWarnings(event.target.checked)}
                />
                只看需要留意的商品
              </label>
            </div>
            {visible.length ? (
              <div className="divide-y divide-stone-100">
                {visible.map((item) => {
                  const detail = statusDetails[item.status];
                  return (
                    <article
                      key={item.productId}
                      className="py-5 first:pt-0 last:pb-0"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="break-words font-medium text-stone-900">
                            {item.name}
                          </h3>
                          <p className="mt-1 text-xs text-stone-500">
                            {productById.get(item.productId)?.category ||
                              "未分类"}
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-3 py-1.5 text-xs font-medium ${detail.color}`}
                        >
                          {detail.label}
                        </span>
                      </div>
                      <dl className="mt-4 grid grid-cols-3 gap-3">
                        <div>
                          <dt className="text-xs text-stone-500">当前库存</dt>
                          <dd className="mt-1 break-words text-base font-semibold tabular-nums text-stone-900">
                            {item.quantity === null
                              ? "待录入"
                              : `${item.quantity.toLocaleString("zh-CN")} 件`}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-stone-500">
                            最近7天销量
                          </dt>
                          <dd className="mt-1 break-words text-base font-medium tabular-nums">
                            {item.sold7Days.toLocaleString("zh-CN")} 件
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-stone-500">
                            预计售罄天数
                          </dt>
                          <dd className="mt-1 break-words text-base font-medium tabular-nums">
                            {daysLabel(item.daysRemaining)}
                          </dd>
                        </div>
                      </dl>
                      <p className="mt-3 text-xs leading-6 text-stone-500">
                        {detail.note}
                      </p>
                      <button
                        type="button"
                        className={`${actionClass} mt-2`}
                        disabled={locked}
                        onClick={() => openCount(item.productId)}
                        aria-label={`${item.quantity === null ? "首次盘点" : "盘点校正"} ${item.name}`}
                      >
                        <ClipboardCheck size={15} aria-hidden="true" />
                        {item.quantity === null ? "首次盘点" : "盘点校正"}
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyRecords
                title={
                  warnings.length
                    ? "没有符合条件的商品"
                    : "先建立商品，再盘点库存"
                }
              >
                {warnings.length ? (
                  "可以更换关键词，或取消提醒筛选。"
                ) : (
                  <Link
                    href="/products"
                    className="text-emerald-800 underline underline-offset-4"
                  >
                    去商品管理添加商品
                  </Link>
                )}
              </EmptyRecords>
            )}
          </section>
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs leading-6 text-stone-600">
            <p>
              近7天包含今天，只统计未作废销售。预计售罄天数 = 当前库存
              ÷（近7天销量 ÷
              7）；例如库存20件、7天卖4件，约可售35天。无销量时单独提醒，不计算天数。只统计已记入账本的销售，漏记会影响估算；近期销量也不保证未来销量。
            </p>
            <p className="mt-1">
              套餐按商品名称独立记库存，不会自动拆扣套餐中的单品；请结合实际存货做进货决定。
            </p>
          </div>
          <section
            className="panel space-y-5"
            aria-labelledby="inventory-receipts-title"
          >
            <div className="flex items-center gap-3">
              <Package
                size={21}
                className="text-emerald-800"
                aria-hidden="true"
              />
              <div>
                <h2 id="inventory-receipts-title" className="font-semibold">
                  进货记录
                </h2>
                <p className="mt-1 text-xs text-stone-500">
                  共 {receipts.length} 笔 · 进货单价保留三位小数
                </p>
              </div>
            </div>
            {receipts.length ? (
              <div className="divide-y divide-stone-100">
                {receipts.map((receipt) => (
                  <article
                    key={receipt.id}
                    className="py-4 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-medium">
                          {productById.get(receipt.productId)?.name ??
                            "历史商品"}
                        </h3>
                        <p className="mt-1 text-xs text-stone-500">
                          {receipt.businessDate} · 进货{" "}
                          {receipt.quantity.toLocaleString("zh-CN")} 件
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-medium tabular-nums">
                        {formatUnitCost(receipt.unitCostMills)}{" "}
                        <span className="text-xs font-normal text-stone-500">
                          /件
                        </span>
                      </p>
                    </div>
                    {receipt.note ? (
                      <p className="mt-2 break-words text-xs leading-6 text-stone-500">
                        备注：{receipt.note}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <EmptyRecords title="还没有进货记录">
                先盘点现有库存；之后每次到货时，再记一笔进货。
              </EmptyRecords>
            )}
            <p className="text-xs leading-6 text-stone-500">
              进货记录用于增加库存，不会把整笔采购金额直接计入当天经营费用，也不会改变已有销售的成本。
            </p>
          </section>
        </>
      )}
      <FormDialog
        open={countOpen}
        title={
          countForm.expectedQuantity === null ? "首次盘点库存" : "盘点校正库存"
        }
        description="数一数眼前实际剩余的商品，把这个数量作为新的库存起点。"
        busy={busy || saving !== null}
        onClose={() => setCountOpen(false)}
      >
        <form onSubmit={saveCount} noValidate className="space-y-5">
          <fieldset disabled={locked} className="space-y-5">
            <label className={labelClass}>
              <span>商品 *</span>
              <select
                autoFocus
                className={inputClass}
                value={countForm.productId}
                onChange={(event) => selectCountProduct(event.target.value)}
              >
                <option value="">请选择商品</option>
                {activeProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              <span>实际剩余数量（件） *</span>
              <input
                className={inputClass}
                inputMode="numeric"
                maxLength={8}
                placeholder="填写0或正整数"
                value={countForm.quantity}
                onChange={(event) =>
                  setCountForm({ ...countForm, quantity: event.target.value })
                }
              />
              <span className="text-xs leading-6 text-stone-500">
                填写盘点后的总数，不是本次增加或减少的数量。确实没有库存时填0。
              </span>
            </label>
            <div className="rounded-xl bg-amber-50 p-4 text-xs leading-6 text-amber-950">
              盘点前的销售已包含在实际剩余数量里，不再重复扣库存；之后保存的新销售与进货会自动更新库存。再次盘点后，旧销售的编辑、作废也不会改动这次盘点起点。请先补齐已发生的销售与进货，再进行盘点。
            </div>
          </fieldset>
          <FormError message={countError} />
          <div className="flex justify-end gap-3 border-t border-stone-100 pt-4">
            <button
              type="button"
              className="button button-secondary min-h-11"
              disabled={busy || saving !== null}
              onClick={() => setCountOpen(false)}
            >
              取消
            </button>
            <button
              className="button button-primary min-h-11"
              disabled={locked}
            >
              {saving === "count" ? "正在保存…" : "确认实际库存"}
            </button>
          </div>
        </form>
      </FormDialog>
      <FormDialog
        open={receiptOpen}
        title="记一笔进货"
        description="只记录最近盘点之后收到的货；未盘点的商品，请先录入实际库存。"
        busy={busy || saving !== null}
        onClose={() => setReceiptOpen(false)}
      >
        <form onSubmit={saveReceipt} noValidate className="space-y-5">
          <fieldset disabled={locked} className="space-y-5">
            <label className={labelClass}>
              <span>进货日期 *</span>
              <input
                autoFocus
                type="date"
                className={inputClass}
                min={
                  receiptBalance
                    ? dateToday(new Date(receiptBalance.countedAt))
                    : undefined
                }
                max={dateToday()}
                value={receiptForm.businessDate}
                onChange={(event) =>
                  setReceiptForm({
                    ...receiptForm,
                    businessDate: event.target.value,
                  })
                }
              />
            </label>
            <label className={labelClass}>
              <span>商品 *</span>
              <select
                className={inputClass}
                value={receiptForm.productId}
                onChange={(event) => selectReceiptProduct(event.target.value)}
              >
                <option value="">请选择已盘点商品</option>
                {initializedProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-4">
              <label className={labelClass}>
                <span>进货数量（件） *</span>
                <input
                  className={inputClass}
                  inputMode="numeric"
                  maxLength={8}
                  placeholder="正整数"
                  value={receiptForm.quantity}
                  onChange={(event) =>
                    setReceiptForm({
                      ...receiptForm,
                      quantity: event.target.value,
                    })
                  }
                />
              </label>
              <label className={labelClass}>
                <span>进货单价（元） *</span>
                <input
                  className={inputClass}
                  inputMode="decimal"
                  maxLength={32}
                  placeholder="0.000"
                  value={receiptForm.cost}
                  onChange={(event) =>
                    setReceiptForm({ ...receiptForm, cost: event.target.value })
                  }
                />
                <span className="text-xs text-stone-500">最多三位小数</span>
              </label>
            </div>
            <label className={labelClass}>
              <span>备注（可选）</span>
              <textarea
                className={`${inputClass} min-h-24 resize-y`}
                maxLength={500}
                placeholder="例如：供货商、到货批次"
                value={receiptForm.note}
                onChange={(event) =>
                  setReceiptForm({ ...receiptForm, note: event.target.value })
                }
              />
            </label>
            <p className="rounded-xl bg-stone-50 p-4 text-xs leading-6 text-stone-600">
              保存后增加库存。进货单价用于本次进货记录，不会改动商品常用进价和已有销售成本。
            </p>
          </fieldset>
          <FormError message={receiptError} />
          <div className="flex justify-end gap-3 border-t border-stone-100 pt-4">
            <button
              type="button"
              className="button button-secondary min-h-11"
              disabled={busy || saving !== null}
              onClick={() => setReceiptOpen(false)}
            >
              取消
            </button>
            <button
              className="button button-primary min-h-11"
              disabled={locked}
            >
              {saving === "receipt" ? "正在保存…" : "保存进货"}
            </button>
          </div>
        </form>
      </FormDialog>
    </div>
  );
}
