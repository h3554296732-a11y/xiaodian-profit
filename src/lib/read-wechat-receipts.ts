import type { WechatReceiptFile } from "./wechat-import-types";
import { parseWechatReceiptRows } from "./wechat-receipts";
import { normalizeWechatXlsx } from "./normalize-wechat-xlsx";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Parse on this device. The original file is never sent to the ledger API. */
export async function readWechatReceiptFile(
  file: File,
): Promise<WechatReceiptFile> {
  if (!/\.xlsx$/i.test(file.name))
    throw new Error("请选择从微信“导出小票单”得到的 .xlsx 文件。");
  if (!file.size || file.size > MAX_FILE_BYTES)
    throw new Error("文件大小需在 2 MB 以内，请在微信中缩小导出日期范围。");
  const bytes = await file.arrayBuffer();
  const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
  if (signature[0] !== 0x50 || signature[1] !== 0x4b)
    throw new Error("文件不是有效的 Excel 文件，请重新从微信导出。");
  let rows: unknown[][];
  try {
    // Loaded only after a file is selected, keeping the normal sales page small.
    const { readSheet } = await import("read-excel-file/universal");
    rows = await readSheet(normalizeWechatXlsx(bytes));
  } catch {
    throw new Error(
      "Excel 文件无法读取，请上传微信导出的原始文件，不要修改后缀。",
    );
  }
  const fileData = await parseWechatReceiptRows(rows);
  if (
    new Set(
      fileData.receipts.flatMap((receipt) =>
        receipt.items.map((item) => item.name),
      ),
    ).size > 100
  )
    throw new Error("每次最多处理 100 种商品，请在微信中缩小导出日期范围。");
  return fileData;
}
