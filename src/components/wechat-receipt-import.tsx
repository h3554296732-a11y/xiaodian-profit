"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import {
  dateToday,
  formatCny,
  MAX_SALE_CENTS,
  MAX_UNIT_MILLS,
  parseUnitCost,
  saleItemCostCents,
} from "@/lib/domain";
import { wechatSaleId } from "@/lib/wechat-receipts";
import type {
  WechatImportPreviewProps,
  WechatImportResult,
  WechatProductBinding,
  WechatReceiptFile,
} from "@/lib/wechat-import-types";
import {
  FormDialog,
  FormError,
  errorMessage,
  inputClass,
  labelClass,
} from "./form-dialog";

type BindingDraft = { productId: string; cost: string };
type PreparedFile = { file: WechatReceiptFile; ids: Map<string, string> };

export default function WechatReceiptImport({
  products,
  sales,
  shopId,
  busy,
  onImport,
}: WechatImportPreviewProps) {
  const [open, setOpen] = useState(false);
  const [prepared, setPrepared] = useState<PreparedFile | null>(null);
  const [bindings, setBindings] = useState<Record<string, BindingDraft>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [salesOnly, setSalesOnly] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WechatImportResult | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const generation = useRef(0);
  const submitting = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const locked = reading || saving || busy;
  const activeProducts = products.filter((product) => !product.deletedAt);
  const productOptions = activeProducts
    .filter((product) =>
      `${product.name} ${product.category}`
        .toLocaleLowerCase()
        .includes(productSearch.trim().toLocaleLowerCase()),
    )
    .slice(0, 50);
  // Include voided sales: reimporting must never resurrect a voided record.
  const existingIds = new Set(sales.map((sale) => sale.id));
  const receipts = prepared?.file.receipts ?? [];
  const alreadyImported = receipts.filter((receipt) =>
    existingIds.has(prepared!.ids.get(receipt.fingerprint)!),
  );
  const eligible = receipts.filter(
    (receipt) =>
      !receipt.issues.length &&
      !receipt.refundMarked &&
      receipt.businessDate <= dateToday() &&
      !existingIds.has(prepared!.ids.get(receipt.fingerprint)!),
  );
  const sourceProducts = new Map<string, number>();
  for (const receipt of eligible)
    for (const item of receipt.items)
      if (!sourceProducts.has(item.name))
        sourceProducts.set(item.name, item.unitPriceCents);
  const importRevenue = eligible.reduce(
    (sum, receipt) => sum + receipt.totalCents,
    0,
  );
  const importExtra = eligible.reduce(
    (sum, receipt) => sum + receipt.extraIncomeCents,
    0,
  );
  const parsedBindings: WechatProductBinding[] = [];
  let missingCosts = 0;
  for (const [name, price] of sourceProducts) {
    const binding = bindings[name];
    try {
      if (!binding || !binding.cost.trim() || !binding.productId)
        throw new Error("missing");
      const costMills = parseUnitCost(binding.cost);
      if (costMills > MAX_UNIT_MILLS) throw new Error("range");
      parsedBindings.push({
        sourceName: name,
        ...(binding.productId === "new"
          ? {}
          : { productId: binding.productId }),
        costMills,
        priceCents: price,
      });
    } catch {
      missingCosts += 1;
    }
  }
  const costByName = new Map(
    parsedBindings.map((binding) => [binding.sourceName, binding.costMills]),
  );
  let importCost: number | null = null;
  let costError = "";
  if (!missingCosts) {
    let total = 0;
    for (const receipt of eligible) {
      let cost = 0;
      for (const item of receipt.items) {
        cost += saleItemCostCents({
          quantity: item.quantity,
          unitCostMills: costByName.get(item.name)!,
        });
        if (!Number.isSafeInteger(cost) || cost > MAX_SALE_CENTS) {
          costError =
            "有小票的商品成本超出允许范围，请检查成本或缩小导入范围。";
          break;
        }
      }
      total += cost;
      if (costError || !Number.isSafeInteger(total)) {
        costError ||= "成本汇总超出允许范围，请缩小导入范围。";
        break;
      }
    }
    if (!costError) importCost = total;
  }
  const excluded = receipts.length - eligible.length - alreadyImported.length;

  function close() {
    if (locked) return;
    generation.current += 1;
    setOpen(false);
    setPrepared(null);
    setBindings({});
    setConfirmed(false);
    setError("");
    setSalesOnly(false);
    setResult(null);
    setProductSearch("");
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected || !shopId || locked) return;
    const token = ++generation.current;
    setReading(true);
    setError("");
    setResult(null);
    setPrepared(null);
    setConfirmed(false);
    try {
      const { readWechatReceiptFile } =
        await import("@/lib/read-wechat-receipts");
      const file = await readWechatReceiptFile(selected);
      const pairs = await Promise.all(
        file.receipts.map(
          async (receipt) =>
            [
              receipt.fingerprint,
              await wechatSaleId(shopId, receipt.fingerprint),
            ] as const,
        ),
      );
      if (token !== generation.current) return;
      const nextBindings: Record<string, BindingDraft> = Object.create(null);
      for (const receipt of file.receipts) {
        for (const item of receipt.items) {
          if (nextBindings[item.name]) continue;
          const matches = activeProducts.filter(
            (product) =>
              product.name.normalize("NFKC").trim().replace(/\s+/gu, " ") ===
              item.name,
          );
          const product = matches.length === 1 ? matches[0] : null;
          nextBindings[item.name] = {
            productId: product?.id ?? (matches.length > 1 ? "" : "new"),
            cost: product ? (product.costMills / 1000).toFixed(3) : "",
          };
        }
      }
      setBindings(nextBindings);
      setPrepared({ file, ids: new Map(pairs) });
    } catch (cause) {
      if (token === generation.current) setError(errorMessage(cause));
    } finally {
      if (token === generation.current) setReading(false);
    }
  }

  function selectProduct(name: string, productId: string) {
    const product = activeProducts.find((item) => item.id === productId);
    setBindings((previous) => ({
      ...previous,
      [name]: {
        ...previous[name],
        productId,
        cost: product ? (product.costMills / 1000).toFixed(3) : "",
      },
    }));
  }

  async function submit() {
    if (
      !prepared ||
      !shopId ||
      locked ||
      submitting.current ||
      !eligible.length
    )
      return;
    if (!confirmed || missingCosts || costError) {
      setError("请补齐商品成本，并确认这些小票已收款且未退款。");
      return;
    }
    const token = generation.current;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const outcome = await onImport({
        merchantName: prepared.file.merchantName,
        receipts: eligible,
        products: parsedBindings,
        confirmedPaidNoRefund: confirmed,
        salesOnly,
      });
      if (token === generation.current) setResult(outcome);
    } catch (cause) {
      if (token === generation.current) setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      if (token === generation.current) setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="button button-secondary min-h-11"
        disabled={busy || !shopId}
        onClick={() => setOpen(true)}
      >
        <FileSpreadsheet size={17} aria-hidden="true" />
        导入微信小票
      </button>
      <FormDialog
        open={open}
        onClose={close}
        busy={locked}
        title="导入微信经营收款小票"
        description="在微信“经营收款 → 下单助手”导出小票单，选择原始 Excel 文件。先预览、补成本，再确认记账。"
      >
        <div className="space-y-5">
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            aria-label="选择微信小票 Excel 文件"
            onChange={chooseFile}
            disabled={locked}
          />
          <button
            type="button"
            className="button button-secondary w-full"
            disabled={locked}
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={17} aria-hidden="true" />
            {reading
              ? "正在读取小票…"
              : prepared
                ? "重新选择 Excel 文件"
                : "选择微信导出的 Excel"}
          </button>
          <p className="text-xs leading-5 text-stone-500">
            每份限 2 MB、500 笔小票、100
            种商品。原文件在当前浏览器读取；顾客姓名、电话、地址和备注不会记入账本。
          </p>
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-6 text-amber-950">
            {salesOnly
              ? "本次仅补记销售和利润，不改变库存数量；已成功导入的记录仍会跳过。"
              : "导入会自动更新已盘点商品的库存；盘点前已收款的旧小票不会重复扣库存。套餐按对应商品独立记库存，不会自动扣除套餐里的单品。"}
          </p>
          <label className="flex gap-3 text-sm leading-6 text-stone-700">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0 accent-emerald-800"
              checked={salesOnly}
              disabled={locked || !!result}
              onChange={(event) => setSalesOnly(event.target.checked)}
            />
            <span>仅补记销售，不改库存（适合补导历史小票）</span>
          </label>
          <FormError message={error} />
          {result && (
            <div
              role="status"
              className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950"
            >
              <p className="font-semibold">
                已导入 {result.imported} 笔，跳过 {result.skipped} 笔，未完成{" "}
                {result.failed} 笔。
              </p>
              <p>
                新增商品 {result.createdProducts}{" "}
                个。已成功的记录会保留，重试会再次检查重复。
              </p>
              {result.errors.map((item, index) => (
                <p key={`${item.sourceRow}-${index}`}>
                  第 {item.sourceRow} 行（{item.paidAt}）：{item.message}
                </p>
              ))}
            </div>
          )}
          {prepared && (
            <>
              <div className="rounded-xl bg-stone-50 p-4 text-sm leading-6">
                <p className="font-semibold text-stone-900">
                  来源店铺：{prepared.file.merchantName}
                </p>
                <p>
                  文件共 {receipts.length} 笔收款，合计{" "}
                  {formatCny(prepared.file.totalCents)}。
                </p>
                <p>
                  可导入 {eligible.length} 笔；已有记录 {alreadyImported.length}{" "}
                  笔；待核对 {excluded} 笔。
                </p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-6 text-amber-950">
                <p>
                  小票没有微信交易单号。系统按来源店名、时间、金额和商品检查疑似重复，已有记录（含已作废）会跳过。内容完全相同的不同交易，请核对后手动记账。
                </p>
                {prepared.file.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
              <details className="rounded-xl border border-stone-200 p-4">
                <summary className="cursor-pointer text-sm font-medium">
                  查看 {receipts.length} 笔小票明细
                </summary>
                <ol className="mt-3 max-h-80 space-y-3 overflow-y-auto">
                  {receipts.map((receipt, index) => {
                    const exists = existingIds.has(
                      prepared.ids.get(receipt.fingerprint)!,
                    );
                    const issues = [
                      ...receipt.issues,
                      ...(receipt.businessDate > dateToday()
                        ? ["日期晚于今天"]
                        : []),
                    ];
                    return (
                      <li
                        key={`${receipt.sourceRow}-${index}`}
                        className="border-t border-stone-100 pt-3 text-xs leading-6"
                      >
                        <p className="flex flex-wrap justify-between gap-x-2 font-medium">
                          <span>{receipt.paidAt}</span>
                          <span>{formatCny(receipt.totalCents)}</span>
                        </p>
                        <p className="text-stone-600">
                          {receipt.items
                            .map((item) => `${item.name} × ${item.quantity}`)
                            .join("；")}
                        </p>
                        <p>额外收入 {formatCny(receipt.extraIncomeCents)}</p>
                        <p
                          className={
                            issues.length || receipt.refundMarked
                              ? "text-amber-800"
                              : "text-stone-500"
                          }
                        >
                          {exists
                            ? "已有记录，跳过"
                            : issues.length
                              ? `待核对：${issues.join("；")}`
                              : receipt.refundMarked
                                ? "有退款标记，暂不导入"
                                : "可导入，需核对收款及退款状态"}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </details>
              {sourceProducts.size > 0 && (
                <section
                  className="space-y-3"
                  aria-labelledby="wechat-cost-title"
                >
                  <h3 id="wechat-cost-title" className="font-semibold">
                    匹配商品，补齐进货成本
                  </h3>
                  <p className="text-xs leading-6 text-stone-500">
                    每个商品填一次，销售价格按原小票保存。调整本次成本不会修改已有商品或历史销售；真实成本为零时请明确填
                    0。单位成本最多保留三位小数；每条明细按数量算成本后四舍五入到分，再合计。
                  </p>
                  <label className={labelClass}>
                    <span>查找已有商品（选填）</span>
                    <input
                      className={inputClass}
                      value={productSearch}
                      disabled={locked}
                      placeholder="输入商品名称或类别，最多显示 50 项"
                      onChange={(event) => setProductSearch(event.target.value)}
                    />
                  </label>
                  {[...sourceProducts].map(([name]) => {
                    const selected = activeProducts.find(
                      (product) => product.id === bindings[name]?.productId,
                    );
                    const options =
                      selected &&
                      !productOptions.some(
                        (product) => product.id === selected.id,
                      )
                        ? [selected, ...productOptions]
                        : productOptions;
                    return (
                      <div
                        key={name}
                        className="space-y-3 rounded-xl border border-stone-200 p-3"
                      >
                        <p className="break-words text-sm font-medium">
                          {name}
                        </p>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <label className={labelClass}>
                            <span>对应商品 · {name}</span>
                            <select
                              className={inputClass}
                              value={bindings[name]?.productId ?? ""}
                              disabled={locked}
                              onChange={(event) =>
                                selectProduct(name, event.target.value)
                              }
                            >
                              <option value="">请选择对应商品</option>
                              <option value="new">新建为「{name}」</option>
                              {options.map((product) => (
                                <option key={product.id} value={product.id}>
                                  {product.name} · {product.category}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className={labelClass}>
                            <span>每件成本（元）· {name}</span>
                            <input
                              className={inputClass}
                              inputMode="decimal"
                              placeholder="必填，最多三位小数，如 0.445"
                              value={bindings[name]?.cost ?? ""}
                              disabled={locked}
                              onChange={(event) =>
                                setBindings((previous) => ({
                                  ...previous,
                                  [name]: {
                                    ...previous[name],
                                    cost: event.target.value,
                                  },
                                }))
                              }
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </section>
              )}
              {eligible.length > 0 && (
                <>
                  <dl className="grid grid-cols-2 gap-3 rounded-xl bg-stone-50 p-4 text-sm">
                    <div>
                      <dt className="text-stone-500">本次收款收入</dt>
                      <dd className="mt-1 font-semibold">
                        {formatCny(importRevenue)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">其中额外收入</dt>
                      <dd className="mt-1 font-semibold">
                        {formatCny(importExtra)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">商品成本</dt>
                      <dd className="mt-1 font-semibold">
                        {costError
                          ? "成本需重新核对"
                          : importCost === null
                            ? `待补 ${missingCosts} 个商品`
                            : formatCny(importCost)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">估算毛利润</dt>
                      <dd className="mt-1 font-semibold">
                        {importCost === null
                          ? "补齐成本后计算"
                          : formatCny(importRevenue - importCost)}
                      </dd>
                    </div>
                  </dl>
                  <FormError
                    message={
                      costError ||
                      (missingCosts
                        ? `还有 ${missingCosts} 个商品需选择对应商品，并填写 0 至 1000000 元之间的每件成本（最多三位小数）。`
                        : "")
                    }
                  />
                  <label className="flex gap-3 text-sm leading-6 text-stone-700">
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0 accent-emerald-800"
                      checked={confirmed}
                      disabled={locked}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    <span>
                      我已核对：本次导入的小票已收款、未退款，商品对应和进货成本正确。退款与优惠记录应另行核对。
                    </span>
                  </label>
                  <button
                    type="button"
                    className="button button-primary w-full"
                    disabled={
                      locked || missingCosts > 0 || !!costError || !confirmed
                    }
                    onClick={submit}
                  >
                    {saving
                      ? "正在逐笔记入账本…"
                      : `确认导入 ${eligible.length} 笔`}
                  </button>
                </>
              )}
              {!eligible.length && !result && (
                <p className="text-sm leading-6 text-stone-600">
                  当前没有可导入的新小票。请检查已有记录或“待核对”提示。
                </p>
              )}
            </>
          )}
        </div>
      </FormDialog>
    </>
  );
}
