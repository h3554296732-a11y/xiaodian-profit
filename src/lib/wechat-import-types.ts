import type { Product, Sale } from "./domain";

/** Only business fields leave the local XLSX reader; customer details are omitted. */
export type WechatReceiptItem = {
  name: string;
  quantity: number;
  unitPriceCents: number;
};

export type WechatReceipt = {
  fingerprint: string;
  sourceRow: number;
  paidAt: string;
  businessDate: string;
  totalCents: number;
  items: WechatReceiptItem[];
  extraIncomeCents: number;
  refundMarked: boolean;
  issues: string[];
};

export type WechatReceiptFile = {
  merchantName: string;
  receipts: WechatReceipt[];
  declaredCount: number | null;
  declaredTotalCents: number | null;
  totalCents: number;
  extraIncomeCents: number;
  warnings: string[];
};

export type WechatProductBinding = {
  sourceName: string;
  /** Existing active product, or omit to create a new one after review. */
  productId?: string;
  costMills: number;
  priceCents: number;
};

export type WechatImportInput = {
  merchantName: string;
  receipts: WechatReceipt[];
  products: WechatProductBinding[];
  confirmedPaidNoRefund: boolean;
  /** Explicitly book historical receipts without changing stock balances. */
  salesOnly?: boolean;
};

export type WechatImportResult = {
  imported: number;
  skipped: number;
  createdProducts: number;
  failed: number;
  errors: { sourceRow: number; paidAt: string; message: string }[];
};

export type WechatImportPreviewProps = {
  products: Product[];
  sales: Sale[];
  shopId: string | null;
  busy: boolean;
  onImport: (input: WechatImportInput) => Promise<WechatImportResult>;
};
