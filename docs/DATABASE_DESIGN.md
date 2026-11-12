# 小店利润本：数据库设计草案

> 已归档：本文保留早期设计、部署或验收记录，文中状态仅对应记录日期。当前功能和使用方法以 [README](../README.md) 与仓库代码为准；新环境的服务配置、价格和可用性请重新核对。

设计日期：2026-10-15。本文是后续实现的设计依据；没有创建数据库、迁移、策略或 RPC，也没有执行数据库安全测试。字段和约束需要在接入阶段实现并验证后才能用于真实商户。

## 1. 数据关系

```text
Supabase auth.users
  └─ shops（一个账号一家店）
       ├─ products（商品当前资料）
       ├─ sales（销售单头）
       │    └─ sale_items（销售明细；关联同店商品）
       └─ expenses（经营费用）
```

店铺是租户边界。除 `shops` 使用 `owner_id` 识别所有人外，其余业务表都必须有非空 `shop_id`。不接受前端传来的“这是我的店”声明作为权限依据，数据库必须根据登录者与店铺所有权校验。

## 2. 统一字段规则

- 主键使用 UUID。时间戳使用 `timestamptz`；由数据库写入 `created_at`、`updated_at`。
- 销售和费用各有非空 `business_date`（`date`），表示商户选择的经营日期；默认按 `Asia/Shanghai` 取得当天。`created_at` 表示录入时刻，不能用来替代补录业务的日期。
- 带 `_cents` 的金额都是整数分，建议 PostgreSQL `bigint`，避免二进制浮点误差；单价、额外收入不得为负，费用金额须大于 0。利润可以为负，但优先由金额字段计算，不额外保存一份利润值。
- 数量使用 `integer` 且大于 0；不支持小数数量或用负数量表示退货。
- 应用层与数据库同时限制名称、备注、行数、数量和金额范围。跨 JSON 边界传递 `bigint` 时使用十进制字符串；若转成 JavaScript `number`，必须验证整个乘积、合计均为安全整数，不能只验证单价。
- 第一版固定 `CNY`、`Asia/Shanghai` 和周一起始；不开放货币及时区随意切换，以免改写历史统计口径。

## 3. 建议表结构

### shops：店铺

| 字段 | 类型 / 规则 | 含义 |
| --- | --- | --- |
| id | uuid 主键 | 店铺标识 |
| owner_id | uuid，非空、唯一，关联 `auth.users.id` | 唯一店主；一个账号只能创建一家店 |
| name | text，非空，去空格后 1–80 字 | 店名 |
| currency | text，固定 `CNY` | 币种 |
| timezone | text，固定 `Asia/Shanghai` | 经营时区 |
| created_at / updated_at | timestamptz | 创建及修改时间 |

所有权在 MVP 中不可转让。`owner_id`、`id` 不允许客户端更新；外键使用限制删除，账号注销必须经过单独的数据导出、保留或清理流程，不能意外级联清空经营记录。

### products：商品

| 字段 | 类型 / 规则 | 含义 |
| --- | --- | --- |
| id / shop_id | uuid 主键 / 非空店铺外键 | 商品及其所属店铺 |
| name | text，去空格后 1–120 字 | 当前名称 |
| category | text，非空，默认“未分类”，最多 40 字 | MVP 先使用简单文本类别 |
| purchase_unit_cost_cents | bigint，非空，≥ 0 | 新销售默认带入的当前单位成本 |
| sale_unit_price_cents | bigint，非空，≥ 0 | 新销售默认带入的当前销售单价 |
| deleted_at | timestamptz，可空 | 非空即停用，业务上的“删除” |
| created_at / updated_at | timestamptz | 创建及修改时间 |

增加 `(shop_id, id)` 唯一约束，供明细建立复合外键。保留停用商品的记录与 ID，不向普通客户端授权物理删除。历史明细不依赖商品当前价格计算。重新建立同名商品会产生新 ID，排行榜也视为不同商品。

### sales：销售单头

| 字段 | 类型 / 规则 | 含义 |
| --- | --- | --- |
| id / shop_id | uuid 主键 / 非空店铺外键 | 单据及店铺 |
| business_date | date，非空 | 本次经营日期 |
| extra_income_cents | bigint，非空，默认 0，≥ 0 | 配送费等额外营业收入，一张单只记录一份 |
| extra_income_note | text，可空，最多 200 字 | 额外收入说明 |
| note | text，可空，最多 500 字 | 整单备注 |
| request_id | uuid，非空 | 客户端一次新增提交的幂等标识 |
| version | integer，非空，默认 1 | 修改并发校验版本 |
| voided_at | timestamptz，可空 | 后续纠错作废使用；作废单不计入分析 |
| created_at / updated_at | timestamptz | 创建及修改时间 |

增加 `(shop_id, id)` 与 `(shop_id, request_id)` 唯一约束。每张有效单至少有一条明细，此规则通过原子提交入口及数据库事务约束验证，普通字段 `CHECK` 无法检查其他行是否存在。本版额外收入依附商品销售单，独立的其他收入账本留待明确需求后扩展。

销售收入、成本、毛利优先根据明细即时汇总，不同时保存可随意修改的总额字段，防止单头与明细不一致。

### sale_items：销售明细

| 字段 | 类型 / 规则 | 含义 |
| --- | --- | --- |
| id / shop_id | uuid 主键 / 非空店铺外键 | 明细及店铺 |
| sale_id / product_id | uuid，均非空 | 所属销售单、当时选择的商品 |
| line_number | integer，> 0 | 单内显示顺序；`(sale_id, line_number)` 唯一 |
| product_name_snapshot | text，非空 | 保存时的商品名称 |
| category_snapshot | text，非空 | 保存时的类别 |
| quantity | integer，> 0 | 销售件数 |
| unit_sale_price_cents | bigint，非空，≥ 0 | 本次实际单位售价快照 |
| unit_cost_cents | bigint，非空，≥ 0 | 本次确认的单位成本快照 |
| created_at / updated_at | timestamptz | 创建及修改时间 |

商品名称、类别、价格或成本改变后，上述快照保持不变。编辑历史销售时默认保留原快照；只有商户明确纠正本条记录时才修改相应内容，不自动读取现价覆盖历史。

额外收入不放进明细。商品行收入为 `quantity × unit_sale_price_cents`，行成本为 `quantity × unit_cost_cents`。商品毛利排行榜按稳定的 `product_id` 分组；历史单据始终显示名称快照。

### expenses：经营费用

| 字段 | 类型 / 规则 | 含义 |
| --- | --- | --- |
| id / shop_id | uuid 主键 / 非空店铺外键 | 费用及店铺 |
| business_date | date，非空 | 费用发生日期 |
| category | text，枚举约束 | `transport`、`packaging`、`loss`、`utilities`、`rent`、`other` |
| amount_cents | bigint，非空，> 0 | 金额 |
| note | text，可空，最多 500 字 | 用途及补充说明 |
| deleted_at | timestamptz，可空 | 后续取消错误费用时保留原记录 |
| created_at / updated_at | timestamptz | 创建及修改时间 |

运输费等按商户选择的费用口径记录，不能再隐含计入单位成本而重复扣除。无库存模块时，损耗只作为商户手动确认的损失金额，不自动减少库存。本版也不根据采购付款自动生成商品销售成本。

## 4. 防止跨店铺关联的外键

只设置 `sale_id → sales.id` 和 `product_id → products.id`，不能阻止一条明细把甲店销售挂到乙店商品。后续必须同时实现：

| 子表字段 | 必须关联的父表字段 | 用途 |
| --- | --- | --- |
| `products.shop_id` | `shops.id` | 商品必须属于现有店铺 |
| `sales.shop_id` | `shops.id` | 销售单必须属于现有店铺 |
| `expenses.shop_id` | `shops.id` | 费用必须属于现有店铺 |
| `sale_items.shop_id` | `shops.id` | 明细具有明确租户 |
| `sale_items.(shop_id, sale_id)` | `sales.(shop_id, id)` | 单头和明细必须同店 |
| `sale_items.(shop_id, product_id)` | `products.(shop_id, id)` | 明细和商品必须同店 |

关联采用限制删除；销售作废、商品停用不删除被引用的数据。所有表的 `id`、`shop_id` 都作为不可变字段处理。RLS 决定能操作哪些行，外键负责关系一致性，两者需要同时存在。[PostgreSQL 约束文档](https://www.postgresql.org/docs/current/ddl-constraints.html)

## 5. RLS 与最小权限

后续在全部五张业务表显式启用 RLS。未登录角色 `anon` 不授予经营数据权限；关闭匿名账号登录。注册、登录由 Supabase Auth 提供，不自行存密码。

所有业务策略限定 `TO authenticated`，并使用 `auth.uid()` 检查实际所有权。定义逻辑条件：

```text
店铺归我：shops.owner_id = 当前登录者 auth.uid()
业务行归我：存在 shops 行，其 id = 本行业务 shop_id，且 owner_id = auth.uid()
```

| 表 | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| shops | 只读自己的店 | 新行 owner_id 必须是自己 | 原行和修改后 owner_id 都必须是自己；禁止改 id、owner_id | 不对客户端开放 |
| products | 只读自己店的商品，含历史所需停用商品 | shop_id 必须指向自己的店 | 原行及修改后均属于自己的店；禁止改 id、shop_id | 不开放物理删除，改 deleted_at |
| sales | 只读自己店的单据 | 只允许自己店铺；由后续原子入口创建 | 前后均归自己；日期、版本等由原子入口校验 | 不开放物理删除，以作废处理 |
| sale_items | 只读自己店的明细 | 归自己且父单、商品同店；由原子入口创建 | 前后均归自己；复合外键持续生效 | 原子历史修改中允许替换明细，整单不能为空 |
| expenses | 只读自己店的费用 | 只允许自己的店 | 前后均属于自己的店；禁止改 id、shop_id | 不开放物理删除，改 deleted_at |

逐项创建策略：SELECT 使用 `USING`；INSERT 使用 `WITH CHECK`；UPDATE 显式同时写 `USING` 与 `WITH CHECK`，并配套 SELECT。即使界面没有所有权输入框，也要阻止伪造请求改变所属店铺。不可变字段还需用数据库触发器或列更新权限约束；不是靠前端隐藏字段实现。[Supabase RLS 文档](https://supabase.com/docs/guides/database/postgres/row-level-security)

将 Data API 的表权限与行权限一起部署，明确各角色可执行的操作。Supabase 近期更改了新表自动授权规则，不能把“已建表”当成“已能通过接口访问”。[Data API 变更公告](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)；[API 安全与显式授权](https://supabase.com/docs/guides/api/securing-your-api)

浏览器只使用适当的 publishable key。不得暴露 secret key 或 `service_role`，它们不能作为普通商户请求的身份。授权不使用用户可编辑的 `user_metadata`。后续如建立汇总视图，应采用调用者权限语义，避免用默认高权限视图绕过 RLS。

## 6. 销售单原子提交与并发

后续新增销售用一次数据库事务 / RPC 同时写入单头及全部明细，任意明细失败就整单回滚。入口从已验证的会话确定店铺，重复校验数量、金额、商品归属和停用状态，不能依赖浏览器计算出的利润。

新增请求使用 `(shop_id, request_id)` 去重；同一请求重试返回原结果，相同标识携带不同内容应拒绝。修改请求携带 `version`，数据库对单头加行锁并比较版本，过期版本返回冲突，不静默覆盖其他页面已保存的修改。修改、作废及恢复都要在同一事务中维护版本和有效明细规则。

优先采用 `SECURITY INVOKER`，保留调用者 RLS 校验。仅靠“前端统一调用 RPC”不能保证其他客户端不拆开写表：实现阶段还须选择并验证提交完整性方案，例如提交时校验“有效单至少一条明细”的延迟约束触发器，并阻止跨请求完成半张单。若必须设计受控特权入口，则放在受限架构中，明确身份校验、固定 `search_path`、撤销默认 EXECUTE，并增加专门的越权测试，不能通过随意加 `SECURITY DEFINER` 解决权限报错。本轮不提前编写或部署此入口。

## 7. 汇总与索引

按所选期间的 `business_date` 查询有效销售单（`voided_at IS NULL`）及费用（`deleted_at IS NULL`）。先把每张单的明细汇总成一行，再加该单额外收入；不要把单头连接多条明细后直接求和额外收入。费用独立汇总，避免与销售联表出现笛卡尔倍增。

今日、周一至今、本月一日至今都使用店铺经营日期。日趋势补齐无记录日期为 0；有收入才计算利润率。商品排行榜只统计有效销售的明细。数据查询应带 `shop_id` 条件，RLS 仍作为数据库防线。

建议索引：`shops(owner_id)`（唯一）、`products(shop_id, deleted_at)`、`sales(shop_id, business_date)`、`expenses(shop_id, business_date)`、`sale_items(shop_id, sale_id)`、`sale_items(shop_id, product_id)`；复合外键对应的父表唯一索引亦须创建。商品搜索初版限定店铺后使用名称匹配，数据增长后再测量是否需要 trigram 索引。

## 8. 接入阶段必须跑的测试

| 测试 | 应观察到的结果 |
| --- | --- |
| 两个正常注册账号 A / B，及未登录请求 | A 可读取和修改自己的数据；B 无法读取或修改；未登录无经营数据访问权 |
| 伪造 shop_id、owner_id 或其他店铺商品 ID | 插入及修改被 RLS、不可变约束或复合外键拒绝；原数据保持完整 |
| A 通过 API 更新 B 的记录 | 不能仅看请求成功；检查返回记录为空，并确认 B 的原值未变 |
| 销售中一条明细非法、明细清空、网络失败 | 没有残留半张有效销售单；重试不产生重复收入 |
| 两个页面同时改同一单 | 一个成功，另一个收到明确版本冲突 |
| 商品改价、改名、停用 | 历史快照、成本和利润不变；停用商品不能新增销售 |
| 一单多商品且有配送费 | 配送费仅计一次；费用不因联表倍增 |
| 0 收入、负利润、分币金额、大数量、月末/周一/补录 | 金额精确、利润率无除零、日期归属正确、超出范围的输入被拒绝 |

通过业务接口模拟商户身份，并在数据库层补充 RLS / 约束测试。不能用管理者或 `service_role` 的成功查询证明商户隔离已经生效。汇总结果始终标“估算经营利润”，缺录税费、人工等成本时不得宣称完整税后净利润。
