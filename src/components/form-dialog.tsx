"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export const inputClass =
  "min-h-11 w-full min-w-0 rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-base text-stone-900 outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-100 disabled:bg-stone-100 disabled:text-stone-500";
export const labelClass = "block space-y-2 text-sm font-medium text-stone-700";
export const actionClass =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-emerald-800 transition hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-50";

export function FormDialog({
  open,
  title,
  description,
  children,
  onClose,
  busy = false,
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      returnFocus.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_24px)] max-w-2xl overflow-y-auto rounded-2xl border border-stone-200 bg-white p-0 text-stone-900 shadow-2xl backdrop:bg-stone-950/45"
    >
      <div className="flex items-start justify-between gap-3 border-b border-stone-100 px-5 py-4 sm:px-6">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description && (
            <p
              id={descriptionId}
              className="mt-1 max-w-lg text-sm leading-6 text-stone-500"
            >
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="关闭弹窗"
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-stone-500 hover:bg-stone-100 disabled:opacity-40"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <div className="p-5 sm:p-6">{children}</div>
    </dialog>
  );
}

export function FormError({ message }: { message: string }) {
  return message ? (
    <p
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800"
    >
      {message}
    </p>
  ) : null;
}
export function LoadingRecords() {
  return (
    <div className="space-y-4" role="status" aria-label="正在读取账本">
      <span className="sr-only">正在读取账本…</span>
      {[0, 1, 2].map((key) => (
        <div
          key={key}
          className="h-28 animate-pulse rounded-xl bg-stone-200/60"
        />
      ))}
    </div>
  );
}
export function EmptyRecords({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-stone-200 px-5 py-12 text-center">
      <p className="font-medium text-stone-700">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-stone-500">
        {children}
      </p>
    </div>
  );
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "保存没有成功，请稍后重试。";
}
