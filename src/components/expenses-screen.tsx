"use client";

import { useRef, useState, type FormEvent } from "react";
import { Pencil, Plus, Receipt, Trash2 } from "lucide-react";
import { useLedger } from "@/components/ledger-provider";
import {
  dateToday,
  formatCny,
  parseMoney,
  validateExpense,
  type Expense,
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

const categories: { value: Expense["category"]; label: string }[] = [
  { value: "transport", label: "运输费" },
  { value: "packaging", label: "包装费" },
  { value: "loss", label: "商品损耗" },
  { value: "utilities", label: "水电费" },
  { value: "rent", label: "租金" },
  { value: "other", label: "其他费用" },
];
const categoryName = (value: Expense["category"]) =>
  categories.find((category) => category.value === value)?.label ?? "其他费用";
const emptyForm = () => ({
  businessDate: dateToday(),
  category: "transport" as Expense["category"],
  amount: "",
  note: "",
});

export default function ExpensesScreen() {
  const { data, ready, busy, saveExpense, deleteExpense } = useLedger();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [category, setCategory] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [confirm, setConfirm] = useState<Expense | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const visible = data.expenses
    .filter(
      (expense) =>
        !expense.deletedAt &&
        (!from || expense.businessDate >= from) &&
        (!to || expense.businessDate <= to) &&
        (!category || expense.category === category),
    )
    .sort(
      (a, b) =>
        b.businessDate.localeCompare(a.businessDate) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const total = visible.reduce((sum, expense) => sum + expense.amountCents, 0);
  function create() {
    if (editing) setForm(emptyForm());
    setEditing(null);
    setError("");
    setOpen(true);
  }
  function edit(expense: Expense) {
    if (editing?.id !== expense.id) {
      setForm({
        businessDate: expense.businessDate,
        category: expense.category,
        amount: (expense.amountCents / 100).toFixed(2),
        note: expense.note,
      });
      setEditing(expense);
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
        businessDate: form.businessDate,
        category: form.category,
        amountCents: parseMoney(form.amount, { allowZero: false }),
        note: form.note.trim(),
      };
      validateExpense(draft);
      await saveExpense(draft, editing?.id);
      setOpen(false);
      setEditing(null);
      setForm(emptyForm());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  async function remove() {
    if (!confirm || submitting.current || busy) return;
    submitting.current = true;
    setSaving(true);
    setActionError("");
    try {
      await deleteExpense(confirm.id);
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
          <p className="eyebrow">EXPENSES · 经营费用</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            小开支，也记在账上
          </h1>
          <p className="muted mt-3">
            记下运输、包装、水电等开支，利润才算得更清楚。
          </p>
        </div>
        <button
          className="button button-primary min-h-11 shrink-0"
          disabled={!ready || busy || saving}
          onClick={create}
        >
          <Plus size={17} aria-hidden="true" />
          记一笔费用
        </button>
      </div>
      {!ready ? (
        <LoadingRecords />
      ) : (
        <>
          <section className="panel space-y-5" aria-labelledby="expenses-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Receipt
                  size={21}
                  className="text-orange-700"
                  aria-hidden="true"
                />
                <div>
                  <h2 id="expenses-title" className="font-semibold">
                    经营费用
                  </h2>
                  <p className="mt-1 text-xs text-stone-500">
                    共 {visible.length} 笔记录
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-stone-500">筛选内费用合计</p>
                <p className="mt-1 break-words text-xl font-semibold tabular-nums text-stone-900">
                  {formatCny(total)}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
              <label className={`${labelClass} col-span-2 sm:col-span-1`}>
                <span>费用类别</span>
                <select
                  className={inputClass}
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  <option value="">全部类别</option>
                  {categories.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {(from || to || category) && (
              <div className="flex justify-end">
                <button
                  className={actionClass}
                  onClick={() => {
                    setFrom("");
                    setTo("");
                    setCategory("");
                  }}
                >
                  清除筛选
                </button>
              </div>
            )}
            {!!from && !!to && from > to && (
              <FormError message="开始日期不能晚于结束日期。" />
            )}
            {visible.length === 0 ? (
              <EmptyRecords
                title={
                  from || to || category
                    ? "没有找到符合条件的费用"
                    : "还没有经营费用记录"
                }
              >
                {from || to || category
                  ? "调整日期或费用类别，查看其他记录。"
                  : "运输、包装、水电和租金等开支，都可以从「记一笔费用」开始记录。"}
              </EmptyRecords>
            ) : (
              <div className="divide-y divide-stone-100">
                {visible.map((expense) => (
                  <article
                    key={expense.id}
                    className="py-5 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-medium text-stone-900">
                          {categoryName(expense.category)}
                        </h3>
                        <time
                          className="mt-1 block text-xs text-stone-500"
                          dateTime={expense.businessDate}
                        >
                          {expense.businessDate}
                        </time>
                      </div>
                      <p className="break-words text-lg font-semibold tabular-nums text-stone-900">
                        {formatCny(expense.amountCents)}
                      </p>
                    </div>
                    {expense.note && (
                      <p className="mt-3 break-words text-sm leading-6 text-stone-600">
                        {expense.note}
                      </p>
                    )}
                    <div className="mt-2 flex justify-end gap-1">
                      <button
                        className={actionClass}
                        disabled={busy || saving}
                        onClick={() => edit(expense)}
                        aria-label={`编辑 ${expense.businessDate} ${categoryName(expense.category)} ${expense.id.slice(-4)}`}
                      >
                        <Pencil size={15} aria-hidden="true" />
                        编辑
                      </button>
                      <button
                        className={`${actionClass} text-stone-500`}
                        disabled={busy || saving}
                        onClick={() => {
                          setConfirm(expense);
                          setActionError("");
                        }}
                        aria-label={`删除 ${expense.businessDate} ${categoryName(expense.category)} ${expense.id.slice(-4)}`}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
          <aside className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-5">
            <h2 className="font-medium text-emerald-900">
              进货款不等于当天卖货的成本
            </h2>
            <p className="mt-2 text-sm leading-7 text-stone-600">
              商品进价在销售时按已售数量计算，请勿把整批进货款重复记为经营费用。过期、破损等商品损耗可按成本单独记录，避免再计入已售商品成本。
            </p>
          </aside>
        </>
      )}
      <FormDialog
        open={open}
        title={editing ? "编辑经营费用" : "记一笔费用"}
        description="按实际发生日期记录开支，自动计入当天的估算经营利润。"
        busy={saving || busy}
        onClose={() => setOpen(false)}
      >
        <form onSubmit={save} noValidate className="space-y-5">
          <fieldset disabled={saving || busy} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
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
              <label className={labelClass}>
                <span>费用类别 *</span>
                <select
                  className={inputClass}
                  value={form.category}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      category: event.target.value as Expense["category"],
                    })
                  }
                >
                  {categories.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className={labelClass}>
              <span>费用金额（元） *</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.amount}
                placeholder="填写实际支出金额"
                onChange={(event) =>
                  setForm({ ...form, amount: event.target.value })
                }
              />
              <span className="block text-xs font-normal leading-5 text-stone-500">
                金额需大于 0，最多保留两位小数。
              </span>
            </label>
            <label className={labelClass}>
              <span>备注</span>
              <textarea
                className={`${inputClass} min-h-22 resize-y`}
                rows={3}
                maxLength={500}
                placeholder="例如：本月电费、到货运费，方便以后查找"
                value={form.note}
                onChange={(event) =>
                  setForm({ ...form, note: event.target.value })
                }
              />
            </label>
            {form.category === "loss" && (
              <p className="rounded-xl bg-amber-50 p-4 text-xs leading-6 text-amber-900">
                损耗按商品成本记录。已记为损耗的商品，请勿再登记为销售，以免重复扣除成本。
              </p>
            )}
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
              {saving ? "正在保存…" : "保存费用"}
            </button>
          </div>
        </form>
      </FormDialog>
      <FormDialog
        open={!!confirm}
        title="删除这笔费用？"
        description={
          confirm
            ? `${confirm.businessDate} · ${categoryName(confirm.category)} ${formatCny(confirm.amountCents)}。删除后，这笔开支将不再计入经营利润。`
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
            onClick={remove}
          >
            {saving ? "正在删除…" : "确认删除"}
          </button>
        </div>
      </FormDialog>
    </div>
  );
}
