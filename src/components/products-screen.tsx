"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  Archive,
  Package,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import { useLedger } from "@/components/ledger-provider";
import {
  formatCny,
  formatUnitCost,
  parseMoney,
  parseUnitCost,
  profitRate,
  validateProduct,
  type Product,
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

const blankForm = { name: "", category: "", cost: "", price: "" };

export default function ProductsScreen() {
  const { data, ready, busy, saveProduct, deleteProduct, restoreProduct } =
    useLedger();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState(blankForm);
  const [editing, setEditing] = useState<Product | null>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<Product | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const active = data.products.filter((product) => !product.deletedAt);
  const inventoryByProduct = new Map(
    (data.inventory ?? []).map((row) => [row.productId, row.quantity]),
  );
  const categories = [
    ...new Set(
      data.products.map((product) => product.category).filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const visible = data.products
    .filter(
      (product) =>
        (showArchived ? !!product.deletedAt : !product.deletedAt) &&
        (!category || product.category === category) &&
        `${product.name} ${product.category}`
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let preview: { profit: number; rate: number | null } | null = null;
  try {
    const cost = parseUnitCost(form.cost);
    const price = parseMoney(form.price, { allowZero: true });
    const profitMills = price * 10 - cost;
    preview = {
      profit: profitMills,
      rate: profitRate(profitMills, price * 10),
    };
  } catch {
    /* Invalid partial input is left editable. */
  }
  function create() {
    if (editing) setForm(blankForm);
    setEditing(null);
    setError("");
    setOpen(true);
  }
  function edit(product: Product) {
    if (editing?.id !== product.id) {
      setEditing(product);
      setForm({
        name: product.name,
        category: product.category,
        cost: (product.costMills / 1000).toFixed(3),
        price: (product.priceCents / 100).toFixed(2),
      });
    }
    setError("");
    setOpen(true);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const draft = {
        name: form.name.trim(),
        category: form.category.trim(),
        costMills: parseUnitCost(form.cost),
        priceCents: parseMoney(form.price, { allowZero: true }),
      };
      validateProduct(draft);
      await saveProduct(draft, editing?.id);
      setOpen(false);
      setEditing(null);
      setForm(blankForm);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  async function archive() {
    if (!confirm || submitting.current || busy) return;
    submitting.current = true;
    setSaving(true);
    setActionError("");
    try {
      await deleteProduct(confirm.id);
      setConfirm(null);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  async function restore(product: Product) {
    if (submitting.current || busy) return;
    submitting.current = true;
    setSaving(true);
    setActionError("");
    try {
      await restoreProduct(product.id);
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
          <p className="eyebrow">PRODUCTS · 商品管理</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            先把商品的账算清楚
          </h1>
          <p className="muted mt-3">
            记好进价与售价，每卖出一件能赚多少，一眼就知道。
          </p>
        </div>
        <button
          className="button button-primary min-h-11 shrink-0"
          disabled={!ready || busy || saving}
          onClick={create}
        >
          <Plus size={17} aria-hidden="true" />
          新增商品
        </button>
      </div>
      {!ready ? (
        <LoadingRecords />
      ) : (
        <>
          <section className="panel space-y-5" aria-label="商品列表">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Package
                  size={21}
                  className="text-emerald-800"
                  aria-hidden="true"
                />
                <div>
                  <h2 className="font-semibold">商品一览</h2>
                  <p className="mt-1 text-xs text-stone-500">
                    {active.length} 件在售商品 · 金额单位：元
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-pressed={showArchived}
                className="button button-secondary min-h-11"
                onClick={() => {
                  setShowArchived(!showArchived);
                  setActionError("");
                }}
              >
                {showArchived ? "返回在售商品" : "查看已停用"}
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <label className={labelClass}>
                <span className="sr-only">搜索商品</span>
                <span className="relative block">
                  <Search
                    size={17}
                    className="pointer-events-none absolute left-3 top-3.5 text-stone-400"
                    aria-hidden="true"
                  />
                  <input
                    className={`${inputClass} pl-10`}
                    type="search"
                    placeholder="搜索商品名称或类别"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </span>
              </label>
              <label className={labelClass}>
                <span className="sr-only">筛选商品类别</span>
                <select
                  className={inputClass}
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  <option value="">全部类别</option>
                  {categories.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            {!confirm && <FormError message={actionError} />}
            {visible.length === 0 ? (
              <EmptyRecords
                title={
                  search || category
                    ? "没有找到符合条件的商品"
                    : showArchived
                      ? "还没有停用的商品"
                      : "从第一件商品开始"
                }
              >
                {search || category
                  ? "试试其他关键词，或清除筛选条件。"
                  : showArchived
                    ? "停用后的商品会在这里保留，也可以随时恢复。"
                    : "点击「新增商品」，填写名称、进价和售价，就能开始记销售。"}
              </EmptyRecords>
            ) : (
              <div className="divide-y divide-stone-100">
                {visible.map((product) => {
                  const profit = product.priceCents * 10 - product.costMills;
                  const rate = profitRate(profit, product.priceCents * 10);
                  return (
                    <article
                      key={product.id}
                      className="py-5 first:pt-0 last:pb-0"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="break-words text-base font-medium text-stone-900">
                            {product.name}
                          </h3>
                          <p className="mt-1 text-xs text-stone-500">
                            {product.category || "未分类"}
                            {product.deletedAt ? " · 已停用" : ""}
                          </p>
                          <p className="mt-2 text-xs text-stone-500">
                            当前库存：
                            {inventoryByProduct.has(product.id)
                              ? `${inventoryByProduct.get(product.id)!.toLocaleString("zh-CN")} 件`
                              : "待录入"}
                            {!product.deletedAt ? (
                              <Link
                                href="/inventory"
                                className="ml-2 text-emerald-800 underline underline-offset-4"
                              >
                                盘点与进货
                              </Link>
                            ) : null}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {product.deletedAt ? (
                            <button
                              className={actionClass}
                              disabled={busy || saving}
                              onClick={() => restore(product)}
                              aria-label={`恢复商品 ${product.name}`}
                            >
                              <RotateCcw size={15} aria-hidden="true" />
                              恢复
                            </button>
                          ) : (
                            <>
                              <button
                                className={actionClass}
                                disabled={busy || saving}
                                onClick={() => edit(product)}
                                aria-label={`编辑商品 ${product.name}`}
                              >
                                <Pencil size={15} aria-hidden="true" />
                                <span className="hidden sm:inline">编辑</span>
                              </button>
                              <button
                                className={`${actionClass} text-stone-500`}
                                disabled={busy || saving}
                                onClick={() => {
                                  setConfirm(product);
                                  setActionError("");
                                }}
                                aria-label={`停用商品 ${product.name}`}
                              >
                                <Archive size={15} aria-hidden="true" />
                                <span className="hidden sm:inline">停用</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                        {[
                          ["进货单价", formatUnitCost(product.costMills)],
                          ["销售单价", formatCny(product.priceCents)],
                          ["单件毛利", formatUnitCost(profit)],
                          [
                            "毛利率",
                            rate === null ? "—" : `${rate.toFixed(1)}%`,
                          ],
                        ].map(([label, value], index) => (
                          <div key={label}>
                            <dt className="text-xs text-stone-500">{label}</dt>
                            <dd
                              className={`mt-1 break-words text-base font-medium tabular-nums ${index >= 2 ? (profit < 0 ? "text-red-700" : "text-emerald-800") : "text-stone-800"}`}
                            >
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          <p className="px-1 text-xs leading-6 text-stone-500">
            单件毛利 = 售价 − 进价；毛利率 = 单件毛利 ÷
            售价。商品毛利还未扣经营费用。调整商品价格不会改变已保存的销售记录。
          </p>
        </>
      )}
      <FormDialog
        open={open}
        title={editing ? "编辑商品" : "新增商品"}
        description="填写商品的常用价格，记销售时还可以调整实际成交价。"
        busy={saving || busy}
        onClose={() => setOpen(false)}
      >
        <form onSubmit={save} noValidate className="space-y-5">
          <fieldset disabled={saving || busy} className="space-y-5">
            <label className={labelClass}>
              <span>
                商品名称 <span className="text-red-600">*</span>
              </span>
              <input
                autoFocus
                className={inputClass}
                maxLength={120}
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                autoComplete="off"
                placeholder="例如：矿泉水 550ml"
              />
            </label>
            <label className={labelClass}>
              <span>类别</span>
              <input
                className={inputClass}
                maxLength={40}
                value={form.category}
                onChange={(event) =>
                  setForm({ ...form, category: event.target.value })
                }
                list="product-category-options"
                placeholder="例如：饮品、零食"
              />
              <datalist id="product-category-options">
                {categories.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </label>
            <div className="grid grid-cols-2 gap-4">
              <label className={labelClass}>
                <span>进货单价（元） *</span>
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={form.cost}
                  onChange={(event) =>
                    setForm({ ...form, cost: event.target.value })
                  }
                  placeholder="0.000"
                />
                <span className="text-xs text-stone-500">最多三位小数</span>
              </label>
              <label className={labelClass}>
                <span>销售单价（元） *</span>
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={form.price}
                  onChange={(event) =>
                    setForm({ ...form, price: event.target.value })
                  }
                  placeholder="0.00"
                />
              </label>
            </div>
            <div
              className={`rounded-xl p-4 ${preview && preview.profit < 0 ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-900"}`}
              aria-live="polite"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <p className="text-sm">
                  单件毛利{" "}
                  <strong className="ml-2 text-lg tabular-nums">
                    {preview ? formatUnitCost(preview.profit) : "—"}
                  </strong>
                </p>
                <p className="text-sm">
                  毛利率{" "}
                  <strong className="ml-2 text-lg tabular-nums">
                    {preview?.rate === null || !preview
                      ? "—"
                      : `${preview.rate.toFixed(1)}%`}
                  </strong>
                </p>
              </div>
              {preview && preview.profit < 0 && (
                <p className="mt-2 text-xs leading-6">
                  当前售价低于进价，会产生亏损；确认价格后仍可保存。
                </p>
              )}
            </div>
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
              {saving ? "正在保存…" : "保存商品"}
            </button>
          </div>
        </form>
      </FormDialog>
      <FormDialog
        open={!!confirm}
        title="停用这件商品？"
        description={
          confirm
            ? `「${confirm.name}」将不再出现在新增销售的选品中，过去的销售和利润保持不变。你可以在已停用商品中恢复。`
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
            onClick={archive}
          >
            {saving ? "正在停用…" : "确认停用"}
          </button>
        </div>
      </FormDialog>
    </div>
  );
}
