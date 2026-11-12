"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import {
  dateToday,
  validateProduct,
  validateSale,
  validateExpense,
  type Ledger,
  type Product,
  type Sale,
  type Expense,
} from "@/lib/domain";
import { cloudConfigured, friendlyError, getSupabase } from "@/lib/supabase";
import { createSessionRecovery } from "@/lib/session-recovery";
import {
  isCurrentRecovery,
  readPasswordRecovery,
  recoverySessionId,
  RECOVERY_STORAGE_KEY,
  updateRecoveryPassword,
  type PasswordRecovery,
} from "@/lib/password-recovery";
import * as repository from "@/lib/cloud-repository";
import { importWechatSales } from "@/lib/import-wechat-sales";
import type { InventoryReceiptDraft } from "@/lib/inventory";
import type {
  WechatImportInput,
  WechatImportResult,
} from "@/lib/wechat-import-types";

export type {
  ProductDraft,
  SaleDraft,
  ExpenseDraft,
} from "@/lib/cloud-repository";
type ProductDraft = repository.ProductDraft;
type SaleDraft = repository.SaleDraft;
type ExpenseDraft = repository.ExpenseDraft;
const EMPTY: Ledger = { products: [], sales: [], expenses: [] };
const MODE_KEY = "xiaodian-profit:local-mode";

type LedgerContextValue = {
  data: Ledger;
  mode: "cloud";
  ready: boolean;
  authReady: boolean;
  busy: boolean;
  loading: boolean;
  user: User | null;
  shopName: string;
  shop: repository.Shop | null;
  error: string | null;
  notice: string | null;
  recovery: boolean;
  recoveryUserId: string | null;
  recoveryEmail: string | null;
  cloudConfigured: boolean;
  clearNotice: () => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  createMyShop: (name: string) => Promise<void>;
  renameShop: (name: string) => Promise<void>;
  saveProduct: (draft: ProductDraft, id?: string) => Promise<void>;
  deleteProduct: (id: string) => Promise<void>;
  restoreProduct: (id: string) => Promise<void>;
  saveSale: (
    draft: SaleDraft,
    id?: string,
    expectedVersion?: number,
    requestId?: string,
  ) => Promise<void>;
  importWechatReceipts: (
    input: WechatImportInput,
  ) => Promise<WechatImportResult>;
  voidSale: (id: string, version: number) => Promise<void>;
  countInventory: (
    productId: string,
    quantity: number,
    requestId: string,
    expectedQuantity: number | null,
  ) => Promise<void>;
  receiveInventory: (draft: InventoryReceiptDraft, id: string) => Promise<void>;
  saveExpense: (draft: ExpenseDraft, id?: string) => Promise<void>;
  deleteExpense: (id: string) => Promise<void>;
  finishRecovery: () => void;
  saveRecoveryPassword: (password: string, userId: string) => Promise<void>;
};
const LedgerContext = createContext<LedgerContextValue | null>(null);

export function LedgerProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Ledger>(EMPTY);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [shop, setShop] = useState<repository.Shop | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<PasswordRecovery | null>(null);
  const recoveryRef = useRef<PasswordRecovery | null>(null);
  const dataRef = useRef<Ledger>(EMPTY);
  const busyRef = useRef(false);
  const scopeRef = useRef(0);
  const newProductIds = useRef(new Map<string, string>());
  const newExpenseIds = useRef(new Map<string, string>());
  const userIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const signOutPendingRef = useRef(false);
  const sessionRecoveryRef = useRef<ReturnType<
    typeof createSessionRecovery
  > | null>(null);
  const setLedger = (next: Ledger) => {
    dataRef.current = next;
    setData(next);
  };
  function changeRecovery(next: PasswordRecovery | null) {
    recoveryRef.current = next;
    setRecovery(next);
    try {
      if (next)
        window.sessionStorage.setItem(
          RECOVERY_STORAGE_KEY,
          JSON.stringify(next),
        );
      else window.sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
    } catch {
      // Storage can be unavailable; this tab can still finish without reloading.
    }
  }
  function finishRecovery() {
    changeRecovery(null);
  }

  useEffect(() => {
    try {
      window.localStorage.removeItem(MODE_KEY);
    } catch {
      // Legacy browser preferences cannot grant access to a cloud ledger.
    }
    const client = getSupabase();
    if (!client) {
      finishRecovery();
      setReady(true);
      setLoading(false);
      return;
    }
    try {
      recoveryRef.current = readPasswordRecovery(
        window.sessionStorage.getItem(RECOVERY_STORAGE_KEY),
      );
      if (!recoveryRef.current) finishRecovery();
    } catch {
      recoveryRef.current = null;
    }
    function acceptUser(next: User | null, accessToken?: string) {
      sessionIdRef.current = accessToken
        ? recoverySessionId(accessToken)
        : null;
      if (
        !isCurrentRecovery(
          recoveryRef.current,
          next?.id ?? null,
          sessionIdRef.current,
        )
      )
        finishRecovery();
      else setRecovery(recoveryRef.current);
      if (userIdRef.current !== (next?.id ?? null)) {
        scopeRef.current += 1;
        newProductIds.current.clear();
        newExpenseIds.current.clear();
        setLedger(EMPTY);
        setShop(null);
        setLoading(true);
        userIdRef.current = next?.id ?? null;
      }
      setUser(next);
      setReady(true);
    }
    const sessionRecovery = createSessionRecovery({
      auth: client.auth,
      onSession(session, event) {
        setAuthError(null);
        // 订阅回调内不 await 数据库，避免 auth 客户端锁等待。
        if (event === "SIGNED_OUT") {
          scopeRef.current += 1;
          setLedger(EMPTY);
          setShop(null);
          finishRecovery();
          setError(null);
        }
        acceptUser(session?.user ?? null, session?.access_token);
        if (!session?.user) setLoading(false);
        if (
          event === "PASSWORD_RECOVERY" &&
          session?.user &&
          sessionIdRef.current
        )
          changeRecovery({
            userId: session.user.id,
            sessionId: sessionIdRef.current,
            email: session.user.email ?? null,
            startedAt: Date.now(),
          });
      },
      onError() {
        setAuthError(
          "暂时无法恢复登录，可能是网络不稳或服务繁忙。请稍后点击“重新加载”重试，无需反复获取验证码。",
        );
        setReady(true);
        setLoading(false);
      },
    });
    sessionRecoveryRef.current = sessionRecovery;
    const retrySession = () => {
      if (sessionRecovery.needsRetry()) void sessionRecovery.restore();
    };
    window.addEventListener("online", retrySession);
    window.addEventListener("pageshow", retrySession);
    void sessionRecovery.restore();
    return () => {
      sessionRecovery.dispose();
      if (sessionRecoveryRef.current === sessionRecovery)
        sessionRecoveryRef.current = null;
      window.removeEventListener("online", retrySession);
      window.removeEventListener("pageshow", retrySession);
    };
  }, []);

  useEffect(() => {
    const scope = ++scopeRef.current;
    setError(null);
    setLoading(true);
    setShop(null);
    setLedger(EMPTY);
    if (!user) {
      setLoading(false);
      return;
    }
    const client = getSupabase()!;
    (async () => {
      const owned = await repository.findShop(client, user.id);
      const next = owned
        ? await repository.loadLedger(client, owned.id)
        : EMPTY;
      if (scope !== scopeRef.current) return;
      setShop(owned);
      setLedger(next);
    })()
      .catch((cause) => {
        if (scope === scopeRef.current) setError(friendlyError(cause));
      })
      .finally(() => {
        if (scope === scopeRef.current) setLoading(false);
      });
  }, [user?.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  async function mutate(
    cloud: (current: Ledger, owned: repository.Shop) => Promise<Ledger>,
    success: string,
  ) {
    if (busyRef.current) throw new Error("正在保存上一笔，请稍候。");
    if (!ready || loading || error || authError)
      throw new Error("账本尚未成功加载，请刷新后再试。");
    busyRef.current = true;
    setBusy(true);
    const scope = scopeRef.current;
    try {
      if (!user || !shop) throw new Error("请先登录并创建自己的店铺。");
      const next = await cloud(dataRef.current, shop);
      if (scope !== scopeRef.current)
        throw new Error("账号状态已变化，请重新打开账本。");
      setLedger(next);
      setNotice(success);
    } catch (cause) {
      throw new Error(friendlyError(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    if (busyRef.current) return;
    if (sessionRecoveryRef.current?.needsRetry()) {
      await sessionRecoveryRef.current.restore();
      return;
    }
    const scope = scopeRef.current;
    setLoading(true);
    setError(null);
    try {
      if (user) {
        const owned = await repository.findShop(getSupabase()!, user.id);
        const next = owned
          ? await repository.loadLedger(getSupabase()!, owned.id)
          : EMPTY;
        if (scope === scopeRef.current) {
          setShop(owned);
          setLedger(next);
        }
      }
    } catch (cause) {
      if (scope === scopeRef.current) setError(friendlyError(cause));
    } finally {
      if (scope === scopeRef.current) setLoading(false);
    }
  }

  async function saveProduct(input: ProductDraft, id?: string) {
    const draft = validateProduct({
      ...input,
      name: input.name.trim(),
      category: input.category.trim() || "未分类",
    });
    const key = JSON.stringify(draft);
    const productId =
      id ?? newProductIds.current.get(key) ?? crypto.randomUUID();
    if (!id) newProductIds.current.set(key, productId);
    const existing = dataRef.current.products.find((p) => p.id === productId);
    const stamp = new Date().toISOString();
    await mutate(
      async (current, owned) => ({
        ...current,
        products: upsert(
          current.products,
          await repository.putProduct(
            getSupabase()!,
            owned.id,
            draft,
            productId,
            existing,
          ),
        ),
      }),
      id
        ? "商品已更新，历史销售保持原来的价格与成本。"
        : "商品已添加，可以开始记录销售了。",
    );
    newProductIds.current.delete(key);
  }
  async function toggleProduct(id: string, deleted: boolean) {
    const existing = dataRef.current.products.find((p) => p.id === id);
    if (!existing) throw new Error("商品不存在，请刷新。");
    await mutate(
      async (current, owned) => ({
        ...current,
        products: upsert(
          current.products,
          await repository.setProductDeleted(
            getSupabase()!,
            owned.id,
            existing,
            deleted,
          ),
        ),
      }),
      deleted ? "商品已停用，历史销售记录仍然保留。" : "商品已恢复。",
    );
  }
  async function saveSale(
    input: SaleDraft,
    id?: string,
    expectedVersion?: number,
    suppliedRequestId?: string,
  ) {
    const draft = validateSale({
      ...input,
      note: input.note.trim(),
      items: input.items.map((row) => ({
        ...row,
        name: row.name.trim(),
        category: row.category.trim() || "未分类",
      })),
    });
    if (draft.businessDate > dateToday())
      throw new Error("销售日期不能晚于今天。");
    const requestId = suppliedRequestId ?? crypto.randomUUID();
    const saleId = id ?? requestId;
    await mutate(
      async (current, owned) => {
        const saved = await repository.putSale(
          getSupabase()!,
          owned.id,
          draft,
          saleId,
          requestId,
          id ? expectedVersion : undefined,
        );
        return refreshInventory(
          { ...current, sales: upsert(current.sales, saved) },
          owned.id,
        );
      },
      id ? "销售已更正，利润已重新计算。" : "销售已记入账本。",
    );
  }
  async function voidSale(id: string, version: number) {
    const old = dataRef.current.sales.find((s) => s.id === id);
    if (!old) throw new Error("销售不存在，请刷新。");
    await mutate(async (current, owned) => {
      const row = await repository.removeSale(getSupabase()!, id, version);
      return refreshInventory(
        {
          ...current,
          sales: upsert(current.sales, {
            ...old,
            version: Number(row.version),
            voidedAt: String(row.voided_at),
          }),
        },
        owned.id,
      );
    }, "销售已作废，不再计入经营利润。");
  }
  // Acknowledged writes remain visible if the follow-up read fails. Block new
  // writes until reload, rather than showing an old balance as current stock.
  async function refreshInventory(
    next: Ledger,
    shopId: string,
  ): Promise<Ledger> {
    const scope = scopeRef.current;
    try {
      return {
        ...next,
        inventory: await repository.loadInventory(getSupabase()!, shopId),
      };
    } catch {
      if (scope === scopeRef.current)
        setError(
          "记录已保存，但库存暂时未能刷新。请点击“重新加载”核对后再记下一笔。",
        );
      return next;
    }
  }
  async function countInventory(
    productId: string,
    quantity: number,
    requestId: string,
    expectedQuantity: number | null,
  ) {
    await mutate(async (current, owned) => {
      await repository.countInventory(
        getSupabase()!,
        productId,
        quantity,
        requestId,
        expectedQuantity,
      );
      return refreshInventory(current, owned.id);
    }, "盘点已保存，此后新销售和新进货会自动更新库存。");
  }
  async function receiveInventory(draft: InventoryReceiptDraft, id: string) {
    await mutate(async (current, owned) => {
      const saved = await repository.receiveInventory(
        getSupabase()!,
        draft,
        id,
      );
      return refreshInventory(
        {
          ...current,
          inventoryReceipts: upsert(current.inventoryReceipts ?? [], saved),
        },
        owned.id,
      );
    }, "进货已记录，库存已增加；商品默认成本和历史利润保持原值。");
  }
  async function importWechatReceipts(
    input: WechatImportInput,
  ): Promise<WechatImportResult> {
    if (busyRef.current) throw new Error("正在保存上一笔，请稍候。");
    if (!ready || loading || error || authError)
      throw new Error("账本尚未成功加载，请刷新后再试。");
    if (!user || !shop) throw new Error("请先登录并创建自己的店铺。");
    const owned = shop;
    const ownerId = user.id;
    const scope = scopeRef.current;
    const client = getSupabase()!;
    const isCurrent = () =>
      scope === scopeRef.current && userIdRef.current === ownerId;
    busyRef.current = true;
    setBusy(true);
    try {
      const outcome = await importWechatSales(input, {
        shopId: owned.id,
        ledger: dataRef.current,
        isCurrent,
        createProduct: (draft, id) =>
          repository.putProduct(client, owned.id, draft, id),
        // Omit expectedVersion: imported records only use the creation path.
        createSale: (draft, id) =>
          repository.putSale(client, owned.id, draft, id, id),
        loadLedger: () => repository.loadLedger(client, owned.id),
        onLedger: (next) => {
          if (isCurrent()) setLedger(next);
        },
      });
      if (outcome.scopeChanged || !isCurrent() || !outcome.ledger)
        throw new Error("账号状态已变化，导入已停止，请重新打开自己的账本。");
      const next = await refreshInventory(outcome.ledger, owned.id);
      if (!isCurrent())
        throw new Error("账号状态已变化，请重新打开自己的账本。");
      setLedger(next);
      const { imported, skipped, failed } = outcome.result;
      setNotice(
        `微信小票：新增 ${imported} 笔，跳过 ${skipped} 笔${failed ? `，${failed} 笔未完成，可重新核对后导入` : ""}。`,
      );
      return outcome.result;
    } catch (cause) {
      throw new Error(friendlyError(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function saveExpense(input: ExpenseDraft, id?: string) {
    const draft = validateExpense({ ...input, note: input.note.trim() });
    if (draft.businessDate > dateToday())
      throw new Error("费用日期不能晚于今天。");
    const key = JSON.stringify(draft);
    const expenseId =
      id ?? newExpenseIds.current.get(key) ?? crypto.randomUUID();
    if (!id) newExpenseIds.current.set(key, expenseId);
    await mutate(
      async (current, owned) => ({
        ...current,
        expenses: upsert(
          current.expenses,
          await repository.putExpense(
            getSupabase()!,
            owned.id,
            draft,
            expenseId,
            Boolean(id),
          ),
        ),
      }),
      id ? "费用已更新。" : "费用已记录，利润已重新计算。",
    );
    newExpenseIds.current.delete(key);
  }
  async function deleteExpense(id: string) {
    await mutate(
      async (current, owned) => ({
        ...current,
        expenses: upsert(
          current.expenses,
          await repository.removeExpense(getSupabase()!, owned.id, id),
        ),
      }),
      "费用已删除，不再计入经营利润。",
    );
  }
  async function signOut() {
    if (signOutPendingRef.current) return;
    signOutPendingRef.current = true;
    const sessionRecovery = sessionRecoveryRef.current;
    sessionRecovery?.beginSignOut();
    scopeRef.current += 1;
    newProductIds.current.clear();
    newExpenseIds.current.clear();
    userIdRef.current = null;
    sessionIdRef.current = null;
    setLedger(EMPTY);
    setShop(null);
    setUser(null);
    setNotice(null);
    setError(null);
    setAuthError("正在退出当前账号，请稍候。");
    finishRecovery();
    try {
      const { error: signOutError } = await getSupabase()!.auth.signOut({
        scope: "local",
      });
      if (signOutError) throw new Error(friendlyError(signOutError));
      sessionRecovery?.completeSignOut();
      setAuthError(null);
    } catch {
      const message = "退出尚未完成，请联网后点击“退出当前账号”重试。";
      setAuthError(message);
      setReady(true);
      setLoading(false);
      // The SDK can retain credentials after a failed refresh or logout. Keep
      // recovery blocked until a later sign-out succeeds; never claim success.
      throw new Error(message);
    } finally {
      signOutPendingRef.current = false;
    }
  }
  async function createMyShop(name: string) {
    if (!user) throw new Error("请先登录。");
    if (!name.trim() || name.trim().length > 80)
      throw new Error("店名请填写 1–80 个字。");
    if (busyRef.current) throw new Error("正在保存，请稍候。");
    const scope = scopeRef.current;
    const ownerId = user.id;
    setBusy(true);
    busyRef.current = true;
    try {
      const owned = await repository.createShop(getSupabase()!, ownerId, name);
      if (scope !== scopeRef.current || userIdRef.current !== ownerId)
        throw new Error("账号已变化，请重新打开账本。");
      setShop(owned);
      setLedger(EMPTY);
      setNotice("店铺已创建，从添加第一件商品开始吧。");
    } catch (cause) {
      throw new Error(friendlyError(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function saveRecoveryPassword(
    password: string,
    expectedUserId: string,
  ) {
    const identity = recoveryRef.current;
    const client = getSupabase();
    if (!client) throw new Error("云端账号尚未配置完成。");
    if (!identity || identity.userId !== expectedUserId)
      throw new Error("密码重置状态已变化，请重新申请重置邮件。");
    await updateRecoveryPassword(
      client.auth,
      identity,
      password,
      () =>
        recoveryRef.current === identity &&
        identity?.userId === expectedUserId &&
        isCurrentRecovery(identity, userIdRef.current, sessionIdRef.current),
    );
    if (recoveryRef.current === identity) {
      finishRecovery();
      setNotice("登录密码已更新。");
    }
  }
  async function renameShop(name: string) {
    if (!name.trim() || name.trim().length > 80)
      throw new Error("店名请填写 1–80 个字。");
    const scope = scopeRef.current;
    if (!shop || !user) throw new Error("请先登录并创建店铺。");
    const { error: updateError } = await getSupabase()!
      .from("shops")
      .update({ name: name.trim() })
      .eq("id", shop.id)
      .eq("owner_id", user.id);
    if (updateError) throw new Error(friendlyError(updateError));
    if (scope !== scopeRef.current || userIdRef.current !== user.id)
      throw new Error("账号已变化，请重新打开账本。");
    setShop({ ...shop, name: name.trim() });
    setNotice("店名已更新。");
  }
  return (
    <LedgerContext.Provider
      value={{
        data,
        mode: "cloud",
        ready: ready && !loading,
        authReady: ready,
        loading,
        busy,
        user,
        shop,
        shopName: shop?.name ?? "我的小店",
        error: authError ?? error,
        notice,
        recovery: recovery !== null,
        recoveryUserId: recovery?.userId ?? null,
        recoveryEmail: recovery?.email ?? null,
        cloudConfigured,
        clearNotice: () => setNotice(null),
        refresh,
        signOut,
        createMyShop,
        renameShop,
        saveProduct,
        deleteProduct: (id) => toggleProduct(id, true),
        restoreProduct: (id) => toggleProduct(id, false),
        saveSale,
        importWechatReceipts,
        voidSale,
        countInventory,
        receiveInventory,
        saveExpense,
        deleteExpense,
        finishRecovery,
        saveRecoveryPassword,
      }}
    >
      {children}
    </LedgerContext.Provider>
  );
}
function upsert<T extends { id: string }>(items: T[], record: T): T[] {
  return items.some((item) => item.id === record.id)
    ? items.map((item) => (item.id === record.id ? record : item))
    : [record, ...items];
}
export function useLedger() {
  const value = useContext(LedgerContext);
  if (!value) throw new Error("LedgerProvider 未加载");
  return value;
}
