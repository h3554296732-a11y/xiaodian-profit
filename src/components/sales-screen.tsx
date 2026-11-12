"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Ban, ClipboardList, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useLedger } from "@/components/ledger-provider";
import WechatReceiptImport from "@/components/wechat-receipt-import";
import {
  dateToday,
  formatCny,
  formatUnitCost,
  parseMoney,
  parseUnitCost,
  profitRate,
  saleTotals,
  validateSale,
  type Product,
  type Sale,
} from "@/lib/domain";
import {
  FormDialog,
  FormError,
  LoadingRecords,
  EmptyRecords,
  inputClass,
  labelClass,
  actionClass,
  errorMessage,
} from "./form-dialog";

type ItemForm = {
  key: string;
  productId: string;
  name: string;
  category: string;
  quantity: string;
  price: string;
  cost: string;
};
type SaleForm = {
  businessDate: string;
  items: ItemForm[];
  extra: string;
  note: string;
};
const emptyForm = (): SaleForm => ({
  businessDate: dateToday(),
  items: [],
  extra: "",
  note: "",
});

export default function SalesScreen() {
  const { data, shop, ready, busy, saveSale, voidSale, importWechatReceipts } =
    useLedger();
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeVoided, setIncludeVoided] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Sale | null>(null);
  const [form, setForm] = useState<SaleForm>(emptyForm);
  const [productSearch, setProductSearch] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [confirm, setConfirm] = useState<Sale | null>(null);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const requestId = useRef("");
  const activeProducts = data.products.filter((product) => !product.deletedAt);
  const choices = activeProducts.filter((product) =>
    `${product.name} ${product.category}`
      .toLocaleLowerCase()
      .includes(productSearch.trim().toLocaleLowerCase()),
  );
  const invalidRange = !!from && !!to && from > to;
  const visible = data.sales
    .filter(
      (sale) =>
        (includeVoided || !sale.voidedAt) &&
        (!from || sale.businessDate >= from) &&
        (!to || sale.businessDate <= to) &&
        `${sale.items.map((item) => item.name).join(" ")} ${sale.note}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        b.businessDate.localeCompare(a.businessDate) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const total = visible
    .filter((sale) => !sale.voidedAt)
    .reduce(
      (sum, sale) => {
        const values = saleTotals(sale);
        return {
          revenue: sum.revenue + values.revenue,
          grossProfit: sum.grossProfit + values.grossProfit,
        };
      },
      { revenue: 0, grossProfit: 0 },
    );
  const totalRate = profitRate(total.grossProfit, total.revenue);

  function draftFromForm() {
    return {
      businessDate: form.businessDate,
      items: form.items.map((item) => {
        if (
          !/^\d+$/.test(item.quantity) ||
          !Number.isSafeInteger(Number(item.quantity)) ||
          Number(item.quantity) < 1
        )
          throw new Error(`「${item.name}」的数量请填写正整数。`);
        return {
          productId: item.productId,
          name: item.name,
          category: item.category,
          quantity: Number(item.quantity),
          unitPriceCents: parseMoney(item.price, { allowZero: true }),
          unitCostMills: parseUnitCost(item.cost),
        };
      }),
      extraIncomeCents: parseMoney(form.extra || "0", { allowZero: true }),
      note: form.note.trim(),
    };
  }
  let preview: ReturnType<typeof saleTotals> | null = null;
  try {
    if (form.items.length) preview = saleTotals(draftFromForm());
  } catch {
    /* Keep partial inputs editable. */
  }

  function create() {
    if (editing) {
      setForm(emptyForm());
      requestId.current = "";
    }
    if (!requestId.current) requestId.current = crypto.randomUUID();
    setEditing(null);
    setProductSearch("");
    setError("");
    setOpen(true);
  }
  function edit(sale: Sale) {
    if (editing?.id !== sale.id) {
      setForm({
        businessDate: sale.businessDate,
        items: sale.items.map((item) => ({
          key: crypto.randomUUID(),
          productId: item.productId,
          name: item.name,
          category: item.category,
          quantity: String(item.quantity),
          price: (item.unitPriceCents / 100).toFixed(2),
          cost: (item.unitCostMills / 1000).toFixed(3),
        })),
        extra: (sale.extraIncomeCents / 100).toFixed(2),
        note: sale.note,
      });
      requestId.current = crypto.randomUUID();
      setEditing(sale);
    }
    setProductSearch("");
    setError("");
    setOpen(true);
  }
  function addProduct(product: Product) {
    setForm((previous) => ({
      ...previous,
      items: [
        ...previous.items,
        {
          key: crypto.randomUUID(),
          productId: product.id,
          name: product.name,
          category: product.category,
          quantity: "1",
          price: (product.priceCents / 100).toFixed(2),
          cost: (product.costMills / 1000).toFixed(3),
        },
      ],
    }));
    setProductSearch("");
  }
  function changeItem(key: string, changes: Partial<ItemForm>) {
    setForm((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.key === key ? { ...item, ...changes } : item,
      ),
    }));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const draft = draftFromForm();
      validateSale(draft);
      await saveSale(draft, editing?.id, editing?.version, requestId.current);
      setOpen(false);
      setEditing(null);
      setForm(emptyForm());
      requestId.current = "";
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  async function voidRecord() {
    if (!confirm || submitting.current || busy) return;
    submitting.current = true;
    setSaving(true);
    setActionError("");
    try {
      await voidSale(confirm.id, confirm.version);
      setConfirm(null);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SALES · 销售记录</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            卖了什么，赚了多少
          </h1>
          <p className="muted mt-3">
            记录实际售价和数量，每笔销售的毛利润自动算好。
          </p>
          <p className="mt-2 text-xs leading-6 text-stone-500">
            盘点后新增的销售自动扣库存；编辑、作废会按最近盘点起点校正。
            <Link
              href="/inventory"
              className="ml-1 text-emerald-800 underline underline-offset-4"
            >
              查看库存与进货
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <WechatReceiptImport
            key={shop?.id ?? "no-shop"}
            products={data.products}
            sales={data.sales}
            shopId={ready ? (shop?.id ?? null) : null}
            busy={busy || saving}
            onImport={importWechatReceipts}
          />
          <button
            className="button button-primary min-h-11 shrink-0"
            disabled={!ready || busy || saving}
            onClick={create}
          >
            <Plus size={17} aria-hidden="true" />
            记一笔销售
          </button>
        </div>
      </div>
      {!ready ? (
        <LoadingRecords />
      ) : (
        <section className="panel space-y-5" aria-labelledby="sales-title">
          <div className="flex items-center gap-3">
            <ClipboardList
              size={21}
              className="text-emerald-800"
              aria-hidden="true"
            />
            <div>
              <h2 id="sales-title" className="font-semibold">
                销售记录
              </h2>
              <p className="mt-1 text-xs text-stone-500">
                共 {visible.length} 笔 · 可补记过去的销售
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_170px_170px]">
            <label className={labelClass}>
              <span>搜索商品或备注</span>
              <span className="relative block">
                <Search
                  size={17}
                  className="pointer-events-none absolute left-3 top-3.5 text-stone-400"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  className={`${inputClass} pl-10`}
                  value={search}
                  placeholder="输入关键词"
                  onChange={(event) => setSearch(event.target.value)}
                />
              </span>
            </label>
            <label className={labelClass}>
              <span>开始日期</span>
              <input
                type="date"
                className={inputClass}
                value={from}
                max={to || dateToday()}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label className={labelClass}>
              <span>结束日期</span>
              <input
                type="date"
                className={inputClass}
                value={to}
                min={from || undefined}
                max={dateToday()}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-stone-600">
              <input
                type="checkbox"
                className="size-5 accent-emerald-800"
                checked={includeVoided}
                onChange={(event) => setIncludeVoided(event.target.checked)}
              />
              包含已作废销售
            </label>
            {(search || from || to) && (
              <button
                type="button"
                className={actionClass}
                onClick={() => {
                  setSearch("");
                  setFrom("");
                  setTo("");
                }}
              >
                清除筛选
              </button>
            )}
          </div>
          {invalidRange && <FormError message="开始日期不能晚于结束日期。" />}
          <div className="grid grid-cols-2 gap-4 rounded-xl bg-emerald-50 px-4 py-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-stone-500">筛选内营业收入</p>
              <p className="mt-1 break-words text-xl font-semibold tabular-nums text-stone-900">
                {formatCny(total.revenue)}
              </p>
            </div>
            <div>
              <p className="text-xs text-stone-500">筛选内毛利润</p>
              <p
                className={`mt-1 break-words text-xl font-semibold tabular-nums ${total.grossProfit < 0 ? "text-red-700" : "text-emerald-800"}`}
              >
                {formatCny(total.grossProfit)}
              </p>
            </div>
            <div>
              <p className="text-xs text-stone-500">筛选内毛利率</p>
              <p
                className={`mt-1 break-words text-xl font-semibold tabular-nums ${total.grossProfit < 0 ? "text-red-700" : "text-emerald-800"}`}
              >
                {totalRate === null ? "—" : `${totalRate.toFixed(1)}%`}
              </p>
            </div>
            <p className="col-span-full text-xs leading-5 text-stone-500">
              毛利润尚未扣经营费用；已作废销售不参与合计。
            </p>
          </div>
          {visible.length === 0 ? (
            <EmptyRecords
              title={
                search || from || to
                  ? "没有找到符合条件的销售"
                  : "还没有销售记录"
              }
            >
              {search || from || to
                ? "调整日期或关键词，查看其他销售记录。"
                : "点击「记一笔销售」，选择商品并填写数量，开始记录店铺收入。"}
            </EmptyRecords>
          ) : (
            <div className="divide-y divide-stone-100">
              {visible.map((sale) => {
                const values = saleTotals(sale);
                const rate = profitRate(values.grossProfit, values.revenue);
                return (
                  <article
                    key={sale.id}
                    className={`py-5 first:pt-0 last:pb-0 ${sale.voidedAt ? "opacity-65" : ""}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="flex flex-wrap items-center gap-2 font-medium text-stone-900">
                          <time dateTime={sale.businessDate}>
                            {sale.businessDate}
                          </time>
                          {sale.voidedAt && (
                            <span className="rounded bg-stone-100 px-2 py-1 text-xs text-stone-600">
                              已作废
                            </span>
                          )}
                        </h3>
                        <p className="mt-1 text-xs text-stone-500">
                          {sale.items.length} 个商品行 · 共{" "}
                          {sale.items.reduce(
                            (sum, item) => sum + item.quantity,
                            0,
                          )}{" "}
                          件
                        </p>
                      </div>
                      {!sale.voidedAt && (
                        <div className="flex gap-1">
                          <button
                            className={actionClass}
                            disabled={busy || saving}
                            onClick={() => edit(sale)}
                            aria-label={`编辑 ${sale.businessDate} 销售 ${sale.id.slice(-4)}`}
                          >
                            <Pencil size={15} aria-hidden="true" />
                            编辑
                          </button>
                          <button
                            className={`${actionClass} text-stone-500`}
                            disabled={busy || saving}
                            onClick={() => {
                              setConfirm(sale);
                              setActionError("");
                            }}
                            aria-label={`作废 ${sale.businessDate} 销售 ${sale.id.slice(-4)}`}
                          >
                            <Ban size={15} aria-hidden="true" />
                            作废
                          </button>
                        </div>
                      )}
                    </div>
                    <p className="mt-3 break-words text-sm leading-6 text-stone-700">
                      {sale.items
                        .map((item) => `${item.name} × ${item.quantity}`)
                        .join("、")}
                    </p>
                    <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                      <div>
                        <dt className="text-xs text-stone-500">营业收入</dt>
                        <dd className="mt-1 break-words text-base font-semibold tabular-nums">
                          {formatCny(values.revenue)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-stone-500">商品销售成本</dt>
                        <dd className="mt-1 break-words text-base tabular-nums">
                          {formatCny(values.cost)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-stone-500">毛利润</dt>
                        <dd
                          className={`mt-1 break-words text-base font-semibold tabular-nums ${values.grossProfit < 0 ? "text-red-700" : "text-emerald-800"}`}
                        >
                          {formatCny(values.grossProfit)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-stone-500">毛利率</dt>
                        <dd
                          className={`mt-1 break-words text-base font-semibold tabular-nums ${values.grossProfit < 0 ? "text-red-700" : "text-emerald-800"}`}
                        >
                          {rate === null ? "—" : `${rate.toFixed(1)}%`}
                        </dd>
                      </div>
                    </dl>
                    <details className="mt-3">
                      <summary className="min-h-11 cursor-pointer py-3 text-sm text-emerald-800">
                        查看明细与备注
                      </summary>
                      <div className="space-y-3 rounded-xl bg-stone-50 p-4">
                        {sale.items.map((item, index) => (
                          <div
                            key={index}
                            className="border-b border-stone-200 pb-3 text-sm last:border-b-0 last:pb-0"
                          >
                            <p className="break-words font-medium">
                              {item.name} × {item.quantity}
                            </p>
                            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs leading-6 text-stone-600">
                              <span>
                                成交单价 {formatCny(item.unitPriceCents)}
                              </span>
                              <span>
                                当时单位成本{" "}
                                {formatUnitCost(item.unitCostMills)}
                              </span>
                              <span>
                                商品收入{" "}
                                {formatCny(item.unitPriceCents * item.quantity)}
                              </span>
                            </p>
                          </div>
                        ))}
                        <p className="text-sm text-stone-600">
                          配送费等其他收入：{formatCny(sale.extraIncomeCents)}
                        </p>
                        {sale.note && (
                          <p className="break-words text-sm leading-6 text-stone-600">
                            备注：{sale.note}
                          </p>
                        )}
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
      <FormDialog
        open={open}
        title={editing ? "编辑销售" : "记一笔销售"}
        description={
          editing
            ? "保留原来的成交价格和成本，按实际情况修改这笔销售。"
            : "选择商品，填写数量；折扣或促销可直接修改成交单价。已盘点商品会自动扣库存。"
        }
        busy={saving || busy}
        onClose={() => setOpen(false)}
      >
        <form onSubmit={save} noValidate className="space-y-5">
          <fieldset disabled={saving || busy} className="space-y-5">
            <label className={labelClass}>
              <span>经营日期 *</span>
              <input
                autoFocus
                type="date"
                className={inputClass}
                value={form.businessDate}
                max={dateToday()}
                onChange={(event) =>
                  setForm({ ...form, businessDate: event.target.value })
                }
              />
            </label>
            <div className="space-y-3 rounded-xl border border-stone-200 p-4">
              <p className="text-sm font-medium text-stone-700">添加商品</p>
              {activeProducts.length ? (
                <>
                  <label className={labelClass}>
                    <span className="sr-only">搜索要添加的商品</span>
                    <input
                      type="search"
                      className={inputClass}
                      placeholder="搜索商品名称或类别"
                      value={productSearch}
                      onChange={(event) => setProductSearch(event.target.value)}
                    />
                  </label>
                  <label className={labelClass}>
                    <span className="sr-only">选择商品并加入销售</span>
                    <select
                      value=""
                      className={inputClass}
                      onChange={(event) => {
                        const product = activeProducts.find(
                          (entry) => entry.id === event.target.value,
                        );
                        if (product) addProduct(product);
                      }}
                    >
                      <option value="">
                        {choices.length ? "选择商品并加入销售" : "没有找到商品"}
                      </option>
                      {choices.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} · {formatCny(product.priceCents)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <p className="text-sm leading-6 text-stone-500">
                  还没有在售商品，先到{" "}
                  <Link
                    href="/products"
                    className="font-medium text-emerald-800 underline underline-offset-4"
                  >
                    商品管理
                  </Link>{" "}
                  添加商品，再回来记销售。
                </p>
              )}
            </div>
            <div className="space-y-3">
              {form.items.map((item, index) => {
                let subtotal: number | null = null;
                try {
                  if (/^\d+$/.test(item.quantity))
                    subtotal =
                      parseMoney(item.price, { allowZero: true }) *
                      Number(item.quantity);
                } catch {
                  /* Partial money input. */
                }
                return (
                  <div
                    key={item.key}
                    className="rounded-xl border border-stone-200 p-4"
                  >
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words font-medium text-stone-900">
                          {index + 1}. {item.name}
                        </p>
                        {data.products.find(
                          (product) => product.id === item.productId,
                        )?.deletedAt && (
                          <p className="mt-1 text-xs text-stone-500">
                            该商品已停用，保留本笔销售的原有记录。
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        className={`${actionClass} shrink-0 text-stone-500`}
                        onClick={() =>
                          setForm((previous) => ({
                            ...previous,
                            items: previous.items.filter(
                              (line) => line.key !== item.key,
                            ),
                          }))
                        }
                        aria-label={`移除第 ${index + 1} 行 ${item.name}`}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <label className={labelClass}>
                        <span>数量（件） *</span>
                        <input
                          className={inputClass}
                          inputMode="numeric"
                          value={item.quantity}
                          onChange={(event) =>
                            changeItem(item.key, {
                              quantity: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className={labelClass}>
                        <span>成交单价（元） *</span>
                        <input
                          className={inputClass}
                          inputMode="decimal"
                          value={item.price}
                          onChange={(event) =>
                            changeItem(item.key, { price: event.target.value })
                          }
                        />
                      </label>
                      <label className={labelClass}>
                        <span>单位成本（元） *</span>
                        <input
                          className={inputClass}
                          inputMode="decimal"
                          value={item.cost}
                          onChange={(event) =>
                            changeItem(item.key, { cost: event.target.value })
                          }
                          placeholder="0.000"
                        />
                        <span className="text-xs text-stone-500">
                          最多三位小数
                        </span>
                      </label>
                    </div>
                    <p className="mt-3 text-right text-sm text-stone-600">
                      商品收入{" "}
                      <strong className="ml-2 font-medium tabular-nums">
                        {subtotal !== null && Number.isSafeInteger(subtotal)
                          ? formatCny(subtotal)
                          : "—"}
                      </strong>
                    </p>
                  </div>
                );
              })}
              {!form.items.length && (
                <p className="py-2 text-center text-sm text-stone-500">
                  选择上方商品后，在这里填写销售数量。
                </p>
              )}
            </div>
            <label className={labelClass}>
              <span>配送费等其他收入（元）</span>
              <input
                className={inputClass}
                inputMode="decimal"
                placeholder="没有可留空"
                value={form.extra}
                onChange={(event) =>
                  setForm({ ...form, extra: event.target.value })
                }
              />
              <span className="block text-xs font-normal leading-5 text-stone-500">
                填写向顾客收取的金额，每笔销售只计算一次。支付出去的配送费请记入经营费用。
              </span>
            </label>
            <label className={labelClass}>
              <span>备注</span>
              <textarea
                className={`${inputClass} min-h-22 resize-y`}
                maxLength={500}
                rows={2}
                placeholder="可填写促销、订单号等，方便以后查找"
                value={form.note}
                onChange={(event) =>
                  setForm({ ...form, note: event.target.value })
                }
              />
            </label>
            <dl
              className="grid grid-cols-2 gap-4 rounded-xl bg-emerald-50 p-4"
              aria-live="polite"
            >
              {[
                ["营业收入", preview?.revenue],
                ["商品销售成本", preview?.cost],
                ["毛利润", preview?.grossProfit],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-xs text-stone-500">{label}</dt>
                  <dd
                    className={`mt-1 break-words text-lg font-semibold tabular-nums ${typeof value === "number" && value < 0 ? "text-red-700" : "text-emerald-900"}`}
                  >
                    {typeof value === "number" ? formatCny(value) : "—"}
                  </dd>
                </div>
              ))}
              <p className="col-span-2 text-xs leading-5 text-stone-500">
                毛利润还未扣经营费用。保存后，将保留本次实际售价和单位成本。
              </p>
            </dl>
          </fieldset>
          <FormError message={error} />
          <div className="flex justify-end gap-3 border-t border-stone-100 pt-4">
            <button
              type="button"
              className="button button-secondary min-h-11"
              disabled={saving || busy}
              onClick={() => setOpen(false)}
            >
              取消
            </button>
            <button
              className="button button-primary min-h-11"
              disabled={saving || busy}
            >
              {saving ? "正在保存…" : "保存销售"}
            </button>
          </div>
        </form>
      </FormDialog>
      <FormDialog
        open={!!confirm}
        title="作废这笔销售？"
        description={
          confirm
            ? `${confirm.businessDate} · 营业收入 ${formatCny(saleTotals(confirm).revenue)}。作废后不再参与利润计算，原始明细仍会保留备查。`
            : ""
        }
        busy={saving || busy}
        onClose={() => setConfirm(null)}
      >
        <FormError message={actionError} />
        <div className="mt-5 flex justify-end gap-3">
          <button
            className="button button-secondary min-h-11"
            disabled={saving || busy}
            onClick={() => setConfirm(null)}
          >
            取消
          </button>
          <button
            className="button button-primary min-h-11"
            disabled={saving || busy}
            onClick={voidRecord}
          >
            {saving ? "正在作废…" : "确认作废"}
          </button>
        </div>
      </FormDialog>
    </div>
  );
}
