import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, zipSync } from "fflate";
import { normalizeWechatXlsx } from "./normalize-wechat-xlsx.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const worksheet = (content: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${content}</sheetData></worksheet>`;
function archive(
  xml: string,
  extra: Record<string, Uint8Array> = {},
): ArrayBuffer {
  return new Uint8Array(
    zipSync({
      "xl/worksheets/sheet1.xml": encode(xml),
      "xl/styles.xml": encode("<styleSheet/>"),
      ...extra,
    }),
  ).buffer;
}
function normalized(xml: string): string {
  const entries = unzipSync(new Uint8Array(normalizeWechatXlsx(archive(xml))));
  return decode(entries["xl/worksheets/sheet1.xml"]);
}

test("所有row和c均缺坐标时按顺序补齐，不改内联转义文本", () => {
  const xml = worksheet(
    '<row><c t="inlineStr"><is><t>&lt;row&gt;&lt;c r=&quot;Z9&quot;/&gt; &amp; 示例</t></is></c><c><v>3</v></c></row><row><c/><c><v>4</v></c></row>',
  );
  const result = normalized(xml);
  assert.ok(result.includes('<row r="1"><c r="A1" t="inlineStr">'));
  assert.ok(result.includes('<c r="B1"><v>3</v></c>'));
  assert.ok(result.includes('<row r="2"><c r="A2"/><c r="B2">'));
  assert.ok(
    result.includes("&lt;row&gt;&lt;c r=&quot;Z9&quot;/&gt; &amp; 示例"),
  );
  assert.equal((result.match(/<row\b/gu) ?? []).length, 2);
});

test("混合坐标保留空列，并从显式单元格推断缺失行号", () => {
  const result = normalized(
    worksheet(
      '<row><c r="B3"/><c/><c r="E3"/></row><row r="5"><c/><c r="C5"/></row><row><c/></row>',
    ),
  );
  assert.ok(result.includes('<row r="3"><c r="B3"/><c r="C3"/><c r="E3"/>'));
  assert.ok(result.includes('<row r="5"><c r="A5"/><c r="C5"/>'));
  assert.ok(result.includes('<row r="6"><c r="A6"/>'));
});

test("保留显式行跳跃、空行和单引号坐标", () => {
  const result = normalized(
    worksheet("<row r='4'><c r='A4'/></row><row r='7'/><row/><row><c/></row>"),
  );
  assert.ok(result.includes("<row r='4'><c r='A4'/></row>"));
  assert.ok(
    result.includes('<row r=\'7\'/><row r="8"/><row r="9"><c r="A9"/>'),
  );
});

test("保留已有合法坐标和工作表以外条目，原输入字节不变", () => {
  const xml = worksheet('<row r="1"><c r="A1"><v>42</v></c></row>');
  const original = archive(xml, {
    "xl/metadata.bin": new Uint8Array([1, 2, 3]),
  });
  const snapshot = new Uint8Array(original).slice();
  const result = unzipSync(new Uint8Array(normalizeWechatXlsx(original)));
  assert.equal(decode(result["xl/worksheets/sheet1.xml"]), xml);
  assert.equal(decode(result["xl/styles.xml"]), "<styleSheet/>");
  assert.deepEqual(result["xl/metadata.bin"], new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(original), snapshot);
});

test("多个工作表都补齐，空sheetData合法", () => {
  const source = archive(worksheet("<row><c/></row>"), {
    "xl/worksheets/sheet2.xml": encode(worksheet("<row><c/></row>")),
  });
  const result = unzipSync(new Uint8Array(normalizeWechatXlsx(source)));
  for (const path of ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"])
    assert.ok(decode(result[path]).includes('<c r="A1"/>'));
  assert.ok(
    normalized("<worksheet><sheetData/></worksheet>").includes("<sheetData/>"),
  );
});

test("拒绝重复或倒退行号和单元格列，以及行列不一致", () => {
  const invalid = [
    '<row r="2"/><row r="2"/>',
    '<row r="3"/><row r="1"/>',
    '<row r="5"><c r="A6"/></row>',
    '<row><c r="B1"/><c r="A1"/></row>',
    '<row><c/><c r="A1"/></row>',
    '<row><c r="A1"/><c r="A2"/></row>',
  ];
  for (const content of invalid)
    assert.throws(() => normalized(worksheet(content)), /倒退|重复|不一致/u);
});

test("行数和列数严格受限，包括隐式递增越界", () => {
  for (const content of [
    '<row r="10001"/>',
    '<row r="10000"/><row/>',
    '<row><c r="A10001"/></row>',
  ])
    assert.throws(() => normalized(worksheet(content)), /10000行/u);
  for (const content of [
    '<row><c r="BM1"/></row>',
    '<row><c r="BL1"/><c/></row>',
  ])
    assert.throws(() => normalized(worksheet(content)), /64列/u);
  assert.ok(
    normalized(worksheet('<row r="10000"><c r="BL10000"/></row>')).includes(
      'r="BL10000"',
    ),
  );
});

test("拒绝不合法、重复坐标属性和错位XML，不能猜测错位数据", () => {
  const invalid = [
    '<worksheet><sheetData><row><c r="A0"/></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="01"/></sheetData></worksheet>',
    '<worksheet><sheetData><row><c r="$A$1"/></row></sheetData></worksheet>',
    '<worksheet><sheetData><row><c r="a1"/></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="1" r="2"/></sheetData></worksheet>',
    "<worksheet><sheetData><row><c/></sheetData></worksheet>",
    "<worksheet><sheetData><row/></worksheet>",
    "<worksheet><sheetData/><sheetData/></worksheet>",
    "<worksheet><sheetData><c/></sheetData></worksheet>",
    "<worksheet><sheetData><row>unexpected<c/></row></sheetData></worksheet>",
    "<worksheet><sheetData><row><unknown/></row></sheetData></worksheet>",
    "<worksheet><sheetData><row><c><v>unescaped & value</v></c></row></sheetData></worksheet>",
    "<worksheet><sheetData><row><c><v>&#0;</v></c></row></sheetData></worksheet>",
    "<worksheet><sheetData><row><c value=unquoted/></row></sheetData></worksheet>",
    '<worksheet><sheetData><row><c r="A1"r="B1"/></row></sheetData></worksheet>',
  ];
  for (const xml of invalid)
    assert.throws(() => normalized(xml), /工作表格式/u);
});

test("DOCTYPE、外部实体和未知实体一律拒绝，不访问任何外部资源", () => {
  const invalid = [
    '<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "https://example.invalid/resource">]><worksheet><sheetData><row><c><v>&xxe;</v></c></row></sheetData></worksheet>',
    "<!DOCTYPE worksheet><worksheet><sheetData/></worksheet>",
    "<worksheet><sheetData><row><c><v>&unknown;</v></c></row></sheetData></worksheet>",
    "<worksheet><sheetData><row><c><v><![CDATA[unexpected]]></v></c></row></sheetData></worksheet>",
  ];
  for (const xml of invalid)
    assert.throws(() => normalized(xml), /工作表格式/u);
  assert.ok(
    normalized(
      worksheet(
        "<row><c><v>&#65;&#x1F600;&apos;&quot;&amp;&lt;&gt;</v></c></row>",
      ),
    ).includes("&#65;&#x1F600;"),
  );
});

test("坏ZIP、缺失工作表和无效UTF8给出可操作错误", () => {
  assert.throws(
    () => normalizeWechatXlsx(new ArrayBuffer(4)),
    /有效的Excel文件/u,
  );
  assert.throws(
    () => normalizeWechatXlsx(new Uint8Array(100).buffer),
    /压缩包损坏/u,
  );
  const good = new Uint8Array(archive(worksheet("<row/>")));
  assert.throws(
    () => normalizeWechatXlsx(good.slice(0, good.length - 40).buffer),
    /压缩包损坏/u,
  );
  assert.throws(
    () =>
      normalizeWechatXlsx(
        new Uint8Array(zipSync({ "xl/workbook.xml": encode("<workbook/>") }))
          .buffer,
      ),
    /没有找到小票工作表/u,
  );
  assert.throws(
    () =>
      normalizeWechatXlsx(
        new Uint8Array(
          zipSync({
            "xl/worksheets/sheet1.xml": new Uint8Array([0xff, 0xfe, 0xff]),
          }),
        ).buffer,
      ),
    /工作表格式/u,
  );
});

test("在解压前拒绝超过100个条目、单XML8MB和总解压16MB", () => {
  const files: Record<string, Uint8Array> = {};
  for (let index = 0; index < 101; index++)
    files[`entry-${index}.bin`] = new Uint8Array([1]);
  assert.throws(
    () => normalizeWechatXlsx(new Uint8Array(zipSync(files)).buffer),
    /大小超限/u,
  );
  assert.throws(
    () =>
      normalizeWechatXlsx(
        archive(worksheet(""), {
          "oversize.xml": new Uint8Array(8 * 1024 * 1024 + 1),
        }),
      ),
    /大小超限/u,
  );
  assert.throws(
    () =>
      normalizeWechatXlsx(
        archive(worksheet(""), {
          "oversize.bin": new Uint8Array(16 * 1024 * 1024 + 1),
        }),
      ),
    /大小超限/u,
  );
});

test("可疑ZIP路径拒绝，不允许目录穿越", () => {
  for (const path of ["../source.xml", "/source.xml", "xl\\sheet.xml"])
    assert.throws(
      () =>
        normalizeWechatXlsx(archive(worksheet(""), { [path]: encode("x") })),
      /压缩包损坏/u,
    );
});
