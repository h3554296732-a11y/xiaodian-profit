import {
  MAX_QUANTITY,
  MAX_SALE_CENTS,
  MAX_UNIT_CENTS,
  parseMoney,
  validateDate,
} from "./domain.ts";
import type {
  WechatReceipt,
  WechatReceiptFile,
  WechatReceiptItem,
} from "./wechat-import-types.ts";

const BUSINESS_HEADERS = [
  "收款时间",
  "收款总金额",
  "收款项",
  "收款项金额",
  "数量",
  "顾客优惠",
  "是否退款",
  "收款来源",
] as const;
type Header = (typeof BUSINESS_HEADERS)[number];
type Columns = Record<Header, number>;
const MAX_ROWS = 10_000;
const MAX_RECEIPTS = 500;
const MAX_ITEMS = 100;

function blank(value: unknown): boolean {
  return value == null || (typeof value === "string" && !value.trim());
}

function cellText(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return blank(value) ? "" : null;
}

function normalizedName(value: string, label: string): string {
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(`${label}不能为空，且最多120个字符`);
  }
  return name;
}

function rowError(row: number, message: string): never {
  throw new Error(`第${row}行${message}，请重新导出完整的小票单文件`);
}

function money(
  value: unknown,
  row: number,
  label: string,
  max: number,
): number {
  const raw = cellText(value);
  if (raw == null || !raw) return rowError(row, `${label}缺失或格式不正确`);
  try {
    const amount = parseMoney(raw.replace(/^[¥￥]\s*/u, ""));
    if (amount > max) return rowError(row, `${label}超出允许范围`);
    return amount;
  } catch {
    return rowError(row, `${label}格式不正确或超出允许范围`);
  }
}

function timestamp(value: unknown, row: number) {
  const raw = cellText(value);
  const match = raw?.match(
    /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u,
  );
  if (!match)
    return rowError(row, "收款时间格式不正确（需要完整日期和时分秒）");
  const businessDate = `${match[1]}-${match[2]}-${match[3]}`;
  try {
    validateDate(businessDate);
  } catch {
    return rowError(row, "收款日期不存在");
  }
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    return rowError(row, "收款时间不存在");
  }
  return {
    businessDate,
    paidAt: `${businessDate} ${match[4]}:${match[5]}:${match[6]}`,
  };
}

function quantity(value: unknown, row: number): number {
  const raw = cellText(value);
  if (raw == null || !/^[1-9]\d*$/u.test(raw))
    return rowError(row, "数量必须是正整数");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_QUANTITY) {
    return rowError(row, "数量超出允许范围");
  }
  return parsed;
}

function addIssue(receipt: WechatReceipt, message: string) {
  if (!receipt.issues.includes(message)) receipt.issues.push(message);
}

function checkRefund(receipt: WechatReceipt, value: unknown) {
  if (blank(value) || value === false || value === 0) return;
  const raw = cellText(value);
  if (raw != null && /^(?:否|未退款|无退款|无|0(?:\.0{1,2})?)$/u.test(raw))
    return;
  receipt.refundMarked = true;
  addIssue(receipt, "退款状态存在标记或无法确认，暂不导入，请先核对退款");
}

function checkDiscount(receipt: WechatReceipt, value: unknown) {
  if (blank(value) || value === 0) return;
  const raw = cellText(value);
  if (raw === "无" || raw === "无优惠") return;
  if (raw != null) {
    try {
      if (parseMoney(raw.replace(/^[¥￥]\s*/u, "")) === 0) return;
    } catch {
      // Unknown discount markers must remain visible, never guessed as zero.
    }
  }
  addIssue(receipt, "顾客优惠非零或无法确认，暂不导入，请先核对实收金额");
}

async function sha256(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "当前浏览器不支持安全识别小票，请使用新版浏览器通过HTTPS打开利润本",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalItems(items: WechatReceiptItem[]) {
  return items
    .map(
      ({ name, unitPriceCents, quantity: count }) =>
        [name, unitPriceCents, count] as const,
    )
    .sort((left, right) =>
      left[0] < right[0]
        ? -1
        : left[0] > right[0]
          ? 1
          : left[1] - right[1] || left[2] - right[2],
    );
}

/** Parse business columns only. Customer fields are never copied or included in identity. */
export async function parseWechatReceiptRows(
  rows: unknown[][],
): Promise<WechatReceiptFile> {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > MAX_ROWS ||
    rows.some((row) => !Array.isArray(row))
  ) {
    throw new Error(
      "小票文件为空或格式不正确；最多读取10000行，请缩小导出日期范围",
    );
  }

  const headerIndex = rows.findIndex((row) =>
    row.some((value) => cellText(value) === "收款时间"),
  );
  if (headerIndex < 0)
    throw new Error("找不到小票表头，请使用“导出小票单”导出的原始Excel文件");
  const header = rows[headerIndex];
  const columns = {} as Columns;
  for (const name of BUSINESS_HEADERS) {
    const matches = header.flatMap((value, index) =>
      cellText(value) === name ? [index] : [],
    );
    if (matches.length !== 1)
      throw new Error(`小票表头缺少或重复“${name}”列，请重新导出原始文件`);
    columns[name] = matches[0];
  }

  let merchantName: string | undefined;
  let declaredCount: number | undefined;
  let declaredTotalCents: number | undefined;
  for (let index = 0; index < headerIndex; index++) {
    for (const value of rows[index]) {
      if (typeof value !== "string") continue;
      const raw = value.trim();
      const title = raw.match(
        /^(?:“([^”]+)”|"([^"]+)"|([^“”"]+?))小票单记录[（(][^\r\n]*[）)]$/u,
      );
      if (title) {
        if (merchantName !== undefined)
          throw new Error("小票文件含有重复店铺标题，请重新导出单个店铺的文件");
        merchantName = normalizedName(
          title[1] ?? title[2] ?? title[3],
          "店铺名称",
        );
      }
      const count = raw.match(/^总收款笔数\s*[:：]\s*(\d+)\s*$/u);
      if (count) {
        if (declaredCount !== undefined)
          throw new Error("小票文件含有重复收款笔数汇总，请重新导出");
        declaredCount = Number(count[1]);
        if (
          !Number.isSafeInteger(declaredCount) ||
          declaredCount < 1 ||
          declaredCount > MAX_RECEIPTS
        ) {
          throw new Error("每次只能导入1到500笔小票，请缩小导出日期范围");
        }
      }
      const total = raw.match(/^总收款金额\s*[:：]\s*(.+)$/u);
      if (total) {
        if (declaredTotalCents !== undefined)
          throw new Error("小票文件含有重复收款金额汇总，请重新导出");
        declaredTotalCents = money(
          total[1],
          index + 1,
          "汇总收款金额",
          Number.MAX_SAFE_INTEGER,
        );
      }
    }
  }
  if (
    !merchantName ||
    declaredCount === undefined ||
    declaredTotalCents === undefined
  ) {
    throw new Error(
      "小票文件缺少店铺标题、总收款笔数或总收款金额，请保留文件顶部汇总并重新导出",
    );
  }

  const receipts: WechatReceipt[] = [];
  let current: WechatReceipt | undefined;
  let blankRefund = false;
  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.every(blank)) continue;
    const rowNumber = index + 1;
    const at = (name: Header) => row[columns[name]];
    if (!blank(at("收款时间"))) {
      if (receipts.length >= MAX_RECEIPTS)
        throw new Error("每次最多导入500笔小票，请缩小导出日期范围");
      const time = timestamp(at("收款时间"), rowNumber);
      current = {
        fingerprint: "",
        sourceRow: rowNumber,
        ...time,
        totalCents: money(
          at("收款总金额"),
          rowNumber,
          "收款总金额",
          MAX_SALE_CENTS,
        ),
        items: [],
        extraIncomeCents: 0,
        refundMarked: false,
        issues: [],
      };
      receipts.push(current);
      if (blank(at("是否退款"))) blankRefund = true;
      if (cellText(at("收款来源")) !== "下单助手") {
        addIssue(current, "收款来源不是“下单助手”，暂不支持导入");
      }
    } else {
      if (!current)
        return rowError(rowNumber, "缺少首笔收款时间，文件可能不完整");
      if (!blank(at("收款总金额")))
        return rowError(rowNumber, "有收款总金额但没有对应时间");
      if (!blank(at("收款来源")) && cellText(at("收款来源")) !== "下单助手") {
        addIssue(current, "收款来源不是“下单助手”，暂不支持导入");
      }
    }
    if (current.items.length >= MAX_ITEMS)
      return rowError(rowNumber, "每笔小票最多支持100行商品");
    const name = cellText(at("收款项"));
    if (name == null || !name)
      return rowError(rowNumber, "商品名称缺失或格式不正确");
    let normalized: string;
    try {
      normalized = normalizedName(name, "商品名称");
    } catch {
      return rowError(rowNumber, "商品名称为空、过长或格式不正确");
    }
    current.items.push({
      name: normalized,
      unitPriceCents: money(
        at("收款项金额"),
        rowNumber,
        "商品单价",
        MAX_UNIT_CENTS,
      ),
      quantity: quantity(at("数量"), rowNumber),
    });
    checkRefund(current, at("是否退款"));
    checkDiscount(current, at("顾客优惠"));
  }

  let totalCents = 0;
  let extraIncomeCents = 0;
  const byFingerprint = new Map<string, WechatReceipt[]>();
  for (const receipt of receipts) {
    let itemGross = 0;
    for (const item of receipt.items) {
      itemGross += item.unitPriceCents * item.quantity;
      if (!Number.isSafeInteger(itemGross) || itemGross > MAX_SALE_CENTS) {
        return rowError(receipt.sourceRow, "商品金额合计超出允许范围");
      }
    }
    receipt.extraIncomeCents = receipt.totalCents - itemGross;
    if (receipt.extraIncomeCents < 0) {
      addIssue(
        receipt,
        "实收金额小于商品合计，暂不导入，请核对优惠、退款或文件完整性",
      );
    }
    totalCents += receipt.totalCents;
    extraIncomeCents += receipt.extraIncomeCents;
    if (
      !Number.isSafeInteger(totalCents) ||
      !Number.isSafeInteger(extraIncomeCents)
    ) {
      throw new Error("文件合计金额超出安全计算范围，请缩小导出日期范围");
    }
    receipt.fingerprint = await sha256([
      "wechat-receipt-v1",
      merchantName,
      receipt.paidAt,
      receipt.totalCents,
      canonicalItems(receipt.items),
    ]);
    const matches = byFingerprint.get(receipt.fingerprint) ?? [];
    matches.push(receipt);
    byFingerprint.set(receipt.fingerprint, matches);
  }
  if (receipts.length !== declaredCount || totalCents !== declaredTotalCents) {
    throw new Error(
      "解析结果与文件顶部的收款笔数或总金额不一致，文件可能被截断或修改，请重新完整导出",
    );
  }
  for (const matches of byFingerprint.values()) {
    if (matches.length > 1) {
      for (const receipt of matches) {
        addIssue(
          receipt,
          "同一文件中有无法区分的相同小票，暂不自动导入，请人工核对",
        );
      }
    }
  }
  const warnings = [
    "原文件没有支付交易单号；相同店铺、时间、金额和商品的小票无法自动区分。",
  ];
  if (blankRefund)
    warnings.push("文件的退款栏为空，导入前请确认所选小票均已收款且没有退款。");
  return {
    merchantName,
    receipts,
    declaredCount,
    declaredTotalCents,
    totalCents,
    extraIncomeCents,
    warnings,
  };
}

function shopNamespace(shopId: string): string {
  if (
    typeof shopId !== "string" ||
    !shopId.trim() ||
    shopId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(shopId)
  ) {
    throw new Error("店铺编号无效，请重新登录后重试");
  }
  return shopId;
}

async function deterministicUuid(parts: string[]): Promise<string> {
  const hex = (await sha256(parts)).slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export async function wechatSaleId(
  shopId: string,
  fingerprint: string,
): Promise<string> {
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint))
    throw new Error("小票识别编号无效，请重新选择文件");
  return deterministicUuid([
    "wechat-sale-v1",
    shopNamespace(shopId),
    fingerprint,
  ]);
}

export async function wechatProductId(
  shopId: string,
  merchantName: string,
  sourceName: string,
): Promise<string> {
  return deterministicUuid([
    "wechat-product-v1",
    shopNamespace(shopId),
    normalizedName(merchantName, "店铺名称"),
    normalizedName(sourceName, "商品名称"),
  ]);
}
