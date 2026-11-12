import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWechatReceiptRows,
  wechatProductId,
  wechatSaleId,
} from "./wechat-receipts.ts";

const headers = [
  "收款时间",
  "收款总金额",
  "付款方昵称",
  "收款项",
  "收款项金额",
  "数量",
  "地址",
  "姓名",
  "手机号",
  "付款备注",
  "商家备注",
  "是否已标记",
  "顾客优惠",
  "是否退款",
  "收款说明",
  "收款来源",
];
function line(
  values: Partial<Record<(typeof headers)[number], unknown>>,
): unknown[] {
  return headers.map((name) => values[name] ?? "");
}
function head(overrides: Record<string, unknown> = {}): unknown[] {
  return line({
    收款时间: "2026/10/20 12:09:01",
    收款总金额: "¥6.50",
    收款项: "示例茶/少冰",
    收款项金额: "¥2.00",
    数量: 3,
    收款来源: "下单助手",
    ...overrides,
  });
}
function file(
  data: unknown[][] = [head()],
  count = 1,
  total = "6.50",
  title = "“示例店铺”小票单记录（2026-10-19 00:00 至2026-10-20 23:59）",
) {
  return [
    [title],
    [""],
    [`总收款笔数：${count}`],
    [`总收款金额：¥${total}`],
    [""],
    [...headers],
    ...data,
  ];
}

test("分组多行小票，商品金额按单价乘数量，保留额外收入", async () => {
  const result = await parseWechatReceiptRows(
    file(
      [
        head({ 收款总金额: "¥7.50", 数量: 2 }),
        line({ 收款项: "示例水", 收款项金额: "3", 数量: 1 }),
        head({ 收款时间: "2026/10/20 13:00:00", 收款总金额: "6.50" }),
      ],
      2,
      "14.00",
    ),
  );
  assert.equal(result.merchantName, "示例店铺");
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts[0].items.length, 2);
  assert.equal(result.receipts[0].extraIncomeCents, 50);
  assert.equal(result.receipts[1].extraIncomeCents, 50);
  assert.equal(result.totalCents, 1400);
  assert.equal(result.extraIncomeCents, 100);
  assert.equal(result.receipts[0].paidAt, "2026-10-20 12:09:01");
  assert.equal(result.receipts[0].businessDate, "2026-10-20");
  assert.equal(result.receipts[0].sourceRow, 7);
  assert.deepEqual(result.receipts[0].issues, []);
  assert.equal(result.receipts[0].refundMarked, false);
  assert.ok(result.warnings.some((warning) => warning.includes("退款栏为空")));
});

test("用分计算0.29，不发生浮点误差", async () => {
  const result = await parseWechatReceiptRows(
    file([head({ 收款项金额: 0.29, 数量: 3, 收款总金额: "1.37" })], 1, "1.37"),
  );
  assert.equal(result.receipts[0].items[0].unitPriceCents, 29);
  assert.equal(result.receipts[0].extraIncomeCents, 50);
});

test("忽略纯空行，但拒绝截断的延续行或有金额无时间", async () => {
  const result = await parseWechatReceiptRows(file([head(), []]));
  assert.equal(result.receipts.length, 1);
  await assert.rejects(
    parseWechatReceiptRows(
      file([line({ 收款项: "示例水", 收款项金额: 2, 数量: 1 })]),
    ),
    /缺少首笔收款时间/,
  );
  await assert.rejects(
    parseWechatReceiptRows(
      file([
        head(),
        line({ 收款总金额: 2, 收款项: "示例水", 收款项金额: 2, 数量: 1 }),
      ]),
    ),
    /有收款总金额但没有对应时间/,
  );
  await assert.rejects(
    parseWechatReceiptRows(file([head(), line({ 商家备注: "非业务空白行" })])),
    /商品名称缺失/,
  );
});

test("退款和未知退款标记都保留识别信息并阻止导入", async () => {
  for (const marker of [
    "是",
    "已退款",
    "部分退款",
    "退款中",
    "待确认状态",
    true,
    1,
  ]) {
    const result = await parseWechatReceiptRows(
      file([head({ 是否退款: marker })]),
    );
    assert.equal(result.receipts[0].refundMarked, true);
    assert.ok(
      result.receipts[0].issues.some((issue) => issue.includes("退款")),
    );
  }
  for (const marker of ["否", "未退款", "无退款", 0, false]) {
    const result = await parseWechatReceiptRows(
      file([head({ 是否退款: marker })]),
    );
    assert.equal(result.receipts[0].refundMarked, false);
    assert.deepEqual(result.receipts[0].issues, []);
  }
});

test("延续行上的退款标记也阻止导入", async () => {
  const result = await parseWechatReceiptRows(
    file([
      head({ 数量: 2 }),
      line({ 收款项: "示例水", 收款项金额: 2, 数量: 1, 是否退款: "是" }),
    ]),
  );
  assert.equal(result.receipts[0].refundMarked, true);
});

test("正优惠及未知优惠不猜测金额，零优惠可正常预览", async () => {
  for (const marker of ["¥1.00", "未确认", "-1.00", true]) {
    const result = await parseWechatReceiptRows(
      file([head({ 顾客优惠: marker })]),
    );
    assert.ok(
      result.receipts[0].issues.some((issue) => issue.includes("优惠")),
    );
  }
  for (const marker of [0, "¥0.00", "无优惠", "0.00"]) {
    const result = await parseWechatReceiptRows(
      file([head({ 顾客优惠: marker })]),
    );
    assert.deepEqual(result.receipts[0].issues, []);
  }
});

test("总金额小于商品合计时标记异常，保留负差额而不强制归零", async () => {
  const result = await parseWechatReceiptRows(
    file([head({ 收款总金额: "5.50" })], 1, "5.50"),
  );
  assert.equal(result.receipts[0].extraIncomeCents, -50);
  assert.equal(result.extraIncomeCents, -50);
  assert.ok(
    result.receipts[0].issues.some((issue) =>
      issue.includes("实收金额小于商品合计"),
    ),
  );
});

test("非下单助手来源阻止导入", async () => {
  const result = await parseWechatReceiptRows(
    file([head({ 收款来源: "其他收款" })]),
  );
  assert.ok(
    result.receipts[0].issues.some((issue) => issue.includes("收款来源")),
  );
});

test("总笔数或总金额不一致拒绝整个文件", async () => {
  await assert.rejects(
    parseWechatReceiptRows(file([head()], 2)),
    /解析结果与文件顶部/,
  );
  await assert.rejects(
    parseWechatReceiptRows(file([head()], 1, "6.51")),
    /解析结果与文件顶部/,
  );
  await assert.rejects(
    parseWechatReceiptRows(file([], 1)),
    /解析结果与文件顶部/,
  );
});

test("缺少汇总、标题或必要表头及重复表头时拒绝整个文件", async () => {
  for (const index of [0, 2, 3]) {
    const rows = file();
    rows[index] = [];
    await assert.rejects(
      parseWechatReceiptRows(rows),
      /缺少店铺标题、总收款笔数或总收款金额/,
    );
  }
  const missing = file();
  missing[5][4] = "不支持的标题";
  await assert.rejects(
    parseWechatReceiptRows(missing),
    /缺少或重复“收款项金额”/,
  );
  const duplicate = file();
  duplicate[5].push("收款时间");
  await assert.rejects(
    parseWechatReceiptRows(duplicate),
    /缺少或重复“收款时间”/,
  );
  const noHeader = file();
  noHeader[5] = [];
  await assert.rejects(parseWechatReceiptRows(noHeader), /找不到小票表头/);
  const duplicatedSummary = file();
  duplicatedSummary[1] = ["总收款笔数：1"];
  await assert.rejects(
    parseWechatReceiptRows(duplicatedSummary),
    /重复收款笔数/,
  );
});

test("允许用户删除隐私列，业务表头重排后仍正确解析", async () => {
  const original = file([
    head({ 付款方昵称: "PRIVATE-NICK-MARKER", 地址: "PRIVATE-ADDRESS-MARKER" }),
  ]);
  const retained = [15, 13, 12, 5, 4, 3, 1, 0];
  const rows = original.map((row, index) =>
    index < 5 ? row : retained.map((column) => row[column]),
  );
  const result = await parseWechatReceiptRows(rows);
  assert.equal(result.receipts[0].totalCents, 650);
  assert.equal(result.receipts[0].items[0].quantity, 3);
});

test("相同业务小票在重叠日期导出、行号变化和商品排序变化后指纹稳定", async () => {
  const first = await parseWechatReceiptRows(
    file(
      [
        head({ 收款总金额: "9.50" }),
        line({ 收款项: "示例水", 收款项金额: "3", 数量: 1 }),
      ],
      1,
      "9.50",
    ),
  );
  const otherTitle =
    "“示例店铺”小票单记录（2026-10-20 00:00 至2026-10-20 23:59）";
  const secondRows = file(
    [
      head({
        收款项: "示例水",
        收款项金额: "3.00",
        数量: 1,
        收款总金额: "9.50",
        是否退款: "是",
      }),
      line({ 收款项: "示例茶/少冰", 收款项金额: 2, 数量: 3 }),
    ],
    1,
    "9.50",
    otherTitle,
  );
  secondRows.splice(1, 0, ["导出说明"]);
  const second = await parseWechatReceiptRows(secondRows);
  assert.notEqual(first.receipts[0].sourceRow, second.receipts[0].sourceRow);
  assert.equal(first.receipts[0].fingerprint, second.receipts[0].fingerprint);
  assert.equal(second.receipts[0].refundMarked, true);
});

test("相同秒、金额、商品的两笔小票都标记为歧义，不能只放行第一笔", async () => {
  const result = await parseWechatReceiptRows(
    file([head(), head()], 2, "13.00"),
  );
  assert.equal(result.receipts[0].fingerprint, result.receipts[1].fingerprint);
  for (const receipt of result.receipts)
    assert.ok(
      receipt.issues.some((issue) => issue.includes("无法区分的相同小票")),
    );
});

test("时间秒数、店铺、商品或金额改变都会改变指纹", async () => {
  const original = (await parseWechatReceiptRows(file())).receipts[0]
    .fingerprint;
  const samples = [
    file([head({ 收款时间: "2026/10/20 12:09:02" })]),
    file([head({ 收款项: "另一示例商品" })]),
    file([head({ 收款总金额: "6.51" })], 1, "6.51"),
    file(
      [head()],
      1,
      "6.50",
      "“另一示例店铺”小票单记录（2026-10-19 00:00 至2026-10-20 23:59）",
    ),
  ];
  for (const sample of samples)
    assert.notEqual(
      (await parseWechatReceiptRows(sample)).receipts[0].fingerprint,
      original,
    );
});

test("客户字段和备注不会出现在结果、指纹或错误中", async () => {
  const markers = [
    "PRIVATE-NICK-MARKER",
    "PRIVATE-ADDRESS-MARKER",
    "PRIVATE-NAME-MARKER",
    "PRIVATE-PHONE-MARKER",
    "PRIVATE-NOTE-MARKER",
  ];
  const plain = await parseWechatReceiptRows(file());
  const privateLine = head({
    付款方昵称: markers[0],
    地址: markers[1],
    姓名: markers[2],
    手机号: markers[3],
    付款备注: markers[4],
  });
  const result = await parseWechatReceiptRows(file([privateLine]));
  assert.equal(result.receipts[0].fingerprint, plain.receipts[0].fingerprint);
  for (const marker of markers)
    assert.ok(!JSON.stringify(result).includes(marker));
  await assert.rejects(
    parseWechatReceiptRows(file([head({ 收款项金额: markers[4] })])),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(markers[4]));
      return true;
    },
  );
});

test("非法金额、单位价格上限和销售金额上限不能被默默跳过", async () => {
  for (const value of [
    "-1",
    "2.001",
    "1e3",
    "02.00",
    "1,000",
    "",
    Infinity,
    {},
    "1000000.01",
  ]) {
    await assert.rejects(
      parseWechatReceiptRows(file([head({ 收款项金额: value })])),
      /商品单价/,
    );
  }
  await assert.rejects(
    parseWechatReceiptRows(
      file([head({ 收款总金额: "10000000000.01" })], 1, "10000000000.01"),
    ),
    /收款总金额/,
  );
});

test("检查真实日历和24小时制，不接受缺秒或自动进位", async () => {
  for (const value of [
    "2026/02/29 12:00:00",
    "2026/10/20 24:00:00",
    "2026/10/20 12:60:00",
    "2026/10/20 12:00:60",
    "2026/10/20 12:09",
    "0000/01/01 00:00:00",
    "2026/1/1 00:00:00",
  ]) {
    await assert.rejects(
      parseWechatReceiptRows(file([head({ 收款时间: value })])),
      /收款(时间|日期)/,
    );
  }
  const leap = await parseWechatReceiptRows(
    file([head({ 收款时间: "2028/02/29 23:59:59" })]),
  );
  assert.equal(leap.receipts[0].businessDate, "2028-02-29");
});

test("数量须在领域范围内且商品名称受长度约束", async () => {
  for (const value of [0, -1, 1.5, "1e2", "01", "", 100001]) {
    await assert.rejects(
      parseWechatReceiptRows(file([head({ 数量: value })])),
      /数量/,
    );
  }
  for (const value of ["", "长".repeat(121), "名称\u0000"]) {
    await assert.rejects(
      parseWechatReceiptRows(file([head({ 收款项: value })])),
      /商品名称/,
    );
  }
});

test("超大行数、小票数及单笔商品行数拒绝，避免无界解析", async () => {
  await assert.rejects(
    parseWechatReceiptRows(Array.from({ length: 10001 }, () => [])),
    /最多读取10000行/,
  );
  await assert.rejects(parseWechatReceiptRows(file([head()], 501)), /1到500笔/);
  const manyItems = Array.from({ length: 100 }, () =>
    line({ 收款项: "示例水", 收款项金额: 0, 数量: 1 }),
  );
  await assert.rejects(
    parseWechatReceiptRows(file([head(), ...manyItems])),
    /最多支持100行商品/,
  );
});

test("确定性UUID带version8及RFC variant，按店铺和来源隔离", async () => {
  const fingerprint = (await parseWechatReceiptRows(file())).receipts[0]
    .fingerprint;
  const sale = await wechatSaleId("shop-a", fingerprint);
  assert.match(
    sale,
    /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  assert.equal(sale, await wechatSaleId("shop-a", fingerprint));
  assert.notEqual(sale, await wechatSaleId("shop-b", fingerprint));
  const product = await wechatProductId(
    "shop-a",
    " 示例店铺 ",
    "示例茶  /少冰",
  );
  assert.equal(
    product,
    await wechatProductId("shop-a", "示例店铺", "示例茶 /少冰"),
  );
  assert.notEqual(product, sale);
  assert.notEqual(
    product,
    await wechatProductId("shop-b", "示例店铺", "示例茶 /少冰"),
  );
  assert.notEqual(
    product,
    await wechatProductId("shop-a", "另一示例店铺", "示例茶 /少冰"),
  );
  await assert.rejects(wechatSaleId("", fingerprint), /店铺编号无效/);
  await assert.rejects(
    wechatSaleId("shop-a", "not-a-fingerprint"),
    /识别编号无效/,
  );
});
