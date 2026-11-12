import { unzipSync, zipSync } from "fflate";

const MAX_ENTRIES = 100;
const MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 64;
const XML_NAME = "[A-Za-z_][A-Za-z0-9_.:-]*";

type XmlTag = {
  name: string;
  start: number;
  end: number;
  parent: XmlTag | null;
  attrs: Map<string, string>;
};

function invalidXml(): never {
  throw new Error("小票Excel的工作表格式不完整或无法识别，请重新导出原始文件");
}

function validateText(text: string) {
  // Do not interpret character references as markup or expand custom entities.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text))
    invalidXml();
  const remaining = text.replace(
    /&(?:amp|lt|gt|apos|quot|#\d+|#x[\da-fA-F]+);/gu,
    (entity) => {
      if (entity.startsWith("&#")) {
        const hexadecimal = entity.startsWith("&#x");
        const code = Number.parseInt(
          entity.slice(hexadecimal ? 3 : 2, -1),
          hexadecimal ? 16 : 10,
        );
        if (!(
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 32 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          (code >= 0x10000 && code <= 0x10ffff)
        ))
          invalidXml();
      }
      return "";
    },
  );
  if (remaining.includes("&")) invalidXml();
}

/** A small strict token reader; it never executes XML or resolves external entities. */
function worksheetTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = [];
  const stack: XmlTag[] = [];
  let position = 0;
  let rootSeen = false;
  let declarationSeen = false;
  const attribute = new RegExp(
    `\\s+(${XML_NAME})\\s*=\\s*("[^"<]*"|'[^'<]*')`,
    "uy",
  );
  const opening = new RegExp(`^<(${XML_NAME})([\\s\\S]*)>$`, "u");
  const closing = new RegExp(`^</(${XML_NAME})\\s*>$`, "u");

  while (position < xml.length) {
    if (xml[position] !== "<") {
      const next = xml.indexOf("<", position);
      const end = next < 0 ? xml.length : next;
      const text = xml.slice(position, end);
      validateText(text);
      const parent = stack.at(-1);
      if (
        (!parent || parent.name === "sheetData" || parent.name === "row") &&
        text.trim()
      )
        invalidXml();
      if (text.includes("]]>")) invalidXml();
      position = end;
      continue;
    }
    if (xml.startsWith("<!--", position)) {
      const end = xml.indexOf("-->", position + 4);
      if (end < 0 || xml.slice(position + 4, end).includes("--")) invalidXml();
      position = end + 3;
      continue;
    }
    if (xml.startsWith("<?", position)) {
      const end = xml.indexOf("?>", position + 2);
      if (end < 0 || rootSeen || declarationSeen) invalidXml();
      const declaration = xml.slice(position, end + 2);
      if (
        !/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'|"utf-8"|'utf-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/u.test(
          declaration,
        )
      )
        invalidXml();
      declarationSeen = true;
      position = end + 2;
      continue;
    }
    if (xml.startsWith("<!", position)) invalidXml();
    // Match a tag without letting a quoted '>' end it prematurely.
    const tagMatch = xml
      .slice(position)
      .match(/^<(?:"[^"]*"|'[^']*'|[^'">])*>/u);
    if (!tagMatch) invalidXml();
    const raw = tagMatch[0];
    const end = position + raw.length;
    if (raw.startsWith("</")) {
      const match = raw.match(closing);
      if (!match || stack.pop()?.name !== match[1]) invalidXml();
      position = end;
      continue;
    }
    const match = raw.match(opening);
    if (!match) invalidXml();
    const name = match[1];
    let body = match[2];
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);
    const attrs = new Map<string, string>();
    let offset = 0;
    while (offset < body.length && body.slice(offset).trim()) {
      attribute.lastIndex = offset;
      const entry = attribute.exec(body);
      if (!entry || attrs.has(entry[1])) invalidXml();
      const value = entry[2].slice(1, -1);
      validateText(value);
      attrs.set(entry[1], value);
      offset = attribute.lastIndex;
    }
    const parent = stack.at(-1) ?? null;
    if (!parent) {
      if (rootSeen || name !== "worksheet") invalidXml();
      rootSeen = true;
    }
    if (
      (name === "sheetData" && parent?.name !== "worksheet") ||
      (name === "row" && parent?.name !== "sheetData") ||
      (name === "c" && parent?.name !== "row")
    )
      invalidXml();
    if (
      (parent?.name === "sheetData" && name !== "row") ||
      (parent?.name === "row" && name !== "c")
    )
      invalidXml();
    const tag: XmlTag = { name, start: position, end, parent, attrs };
    tags.push(tag);
    if (!selfClosing) stack.push(tag);
    position = end;
  }
  if (
    !rootSeen ||
    stack.length ||
    tags.filter((tag) => tag.name === "sheetData").length !== 1
  )
    invalidXml();
  return tags;
}

function rowNumber(value: string): number {
  if (!/^[1-9]\d{0,4}$/u.test(value)) invalidXml();
  const row = Number(value);
  if (row > MAX_ROWS)
    throw new Error("小票工作表超过10000行，请缩小导出日期范围");
  return row;
}

function cellAddress(value: string) {
  const match = value.match(/^([A-Z]{1,3})([1-9]\d{0,4})$/u);
  if (!match) invalidXml();
  let column = 0;
  for (const letter of match[1])
    column = column * 26 + letter.charCodeAt(0) - 64;
  if (column > MAX_COLUMNS)
    throw new Error("小票工作表超过64列，请使用原始小票导出文件");
  return { row: rowNumber(match[2]), column };
}

function columnName(column: number): string {
  let name = "";
  while (column > 0) {
    column--;
    name = String.fromCharCode(65 + (column % 26)) + name;
    column = Math.floor(column / 26);
  }
  return name;
}

function normalizeWorksheet(xml: string): string {
  const tags = worksheetTags(xml);
  const edits: { at: number; value: string }[] = [];
  let previousRow = 0;
  const cellsByRow = new Map<XmlTag, XmlTag[]>();
  for (const tag of tags) {
    if (tag.name === "c") {
      const cells = cellsByRow.get(tag.parent!) ?? [];
      cells.push(tag);
      cellsByRow.set(tag.parent!, cells);
    }
  }
  for (const tag of tags) {
    if (tag.name !== "row") continue;
    const cells = cellsByRow.get(tag) ?? [];
    const explicitCell = cells.find((cell) => cell.attrs.has("r"));
    const explicitRow = tag.attrs.get("r");
    const row =
      explicitRow !== undefined
        ? rowNumber(explicitRow)
        : explicitCell
          ? cellAddress(explicitCell.attrs.get("r")!).row
          : previousRow + 1;
    if (row > MAX_ROWS)
      throw new Error("小票工作表超过10000行，请缩小导出日期范围");
    if (row <= previousRow)
      throw new Error("小票工作表的行号倒退或重复，请重新导出原始文件");
    previousRow = row;
    if (explicitRow === undefined)
      edits.push({ at: tag.start + "<row".length, value: ` r="${row}"` });
    let previousColumn = 0;
    for (const cell of cells) {
      const reference = cell.attrs.get("r");
      const address =
        reference === undefined
          ? { row, column: previousColumn + 1 }
          : cellAddress(reference);
      if (address.row !== row || address.column <= previousColumn)
        throw new Error(
          "小票工作表的单元格坐标不一致、倒退或重复，请重新导出原始文件",
        );
      if (address.column > MAX_COLUMNS)
        throw new Error("小票工作表超过64列，请使用原始小票导出文件");
      previousColumn = address.column;
      if (reference === undefined)
        edits.push({
          at: cell.start + "<c".length,
          value: ` r="${columnName(address.column)}${row}"`,
        });
    }
  }
  edits.sort((left, right) => left.at - right.at);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(xml.slice(cursor, edit.at), edit.value);
    cursor = edit.at;
  }
  parts.push(xml.slice(cursor));
  return parts.join("");
}

/** Repair missing WeChat worksheet coordinates in memory; never writes the source file. */
export function normalizeWechatXlsx(bytes: ArrayBuffer): ArrayBuffer {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 22)
    throw new Error("文件不是有效的Excel文件，请重新导出.xlsx小票文件");
  const names = new Set<string>();
  let declaredBytes = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(bytes), {
      filter: (entry) => {
        if (
          names.has(entry.name) ||
          entry.name.includes("\\") ||
          entry.name.startsWith("/") ||
          entry.name
            .split("/")
            .some((part) => part === ".." || part === "__proto__")
        )
          throw new Error("压缩包目录异常");
        names.add(entry.name);
        if (names.size > MAX_ENTRIES) throw new Error("文件条目超过100个");
        if (
          !Number.isSafeInteger(entry.originalSize) ||
          entry.originalSize < 0 ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          (entry.compression === 0 && entry.originalSize !== entry.size)
        )
          throw new Error("文件大小异常");
        declaredBytes += entry.originalSize;
        if (
          declaredBytes > MAX_UNCOMPRESSED_BYTES ||
          (/\.xml$/iu.test(entry.name) && entry.originalSize > MAX_XML_BYTES)
        )
          throw new Error("解压后的文件过大");
        return true;
      },
    });
  } catch {
    throw new Error(
      "Excel压缩包损坏或解压大小超限（总计16MB、单个XML 8MB、100个文件），请缩小范围并重新导出",
    );
  }
  let actualBytes = 0;
  let worksheetCount = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  for (const [name, data] of Object.entries(entries)) {
    actualBytes += data.byteLength;
    if (
      actualBytes > MAX_UNCOMPRESSED_BYTES ||
      (/\.xml$/iu.test(name) && data.byteLength > MAX_XML_BYTES)
    )
      throw new Error("Excel解压大小超过允许范围，请缩小导出日期范围");
    if (!/^xl\/worksheets\/sheet[1-9]\d*\.xml$/u.test(name)) continue;
    worksheetCount++;
    let xml: string;
    try {
      xml = decoder.decode(data);
    } catch {
      return invalidXml();
    }
    entries[name] = encoder.encode(normalizeWorksheet(xml));
  }
  if (!worksheetCount)
    throw new Error("Excel中没有找到小票工作表，请选择微信导出的原始.xlsx文件");
  try {
    const result = zipSync(entries, { level: 6 });
    return new Uint8Array(result).buffer;
  } catch {
    throw new Error("整理小票文件失败，请缩小导出日期范围后重试");
  }
}
