# 数据库实现与验证

> 已归档：本文保留早期设计、部署或验收记录，文中状态仅对应记录日期。当前功能和使用方法以 [README](../README.md) 与仓库代码为准；新环境的服务配置、价格和可用性请重新核对。

更新日期：2026-10-20。数据库当前完整结构为 `supabase/schema.sql`，初始迁移为 `supabase/migrations/20261015140338_initial_profit_schema.sql`，增量修复依次为 `supabase/migrations/20261015233452_historical_sale_line_identity.sql`、`supabase/migrations/20261020082002_unit_cost_mills.sql`。完整结构和初始迁移仅适用于**空的 Supabase 项目**，使用已有的 `auth.users`、`auth.uid()`、`anon` 和 `authenticated` 角色；已有初始结构的数据库只应用增量迁移。本文记录本机数据库验证和目标云项目 `nporrbvnaezafvryjqao` 的公开接口验收范围，不会自动连接或修改数据库。

## 当前已验证与待验证

已使用 `@electric-sql/pglite` 在本机运行真实 PostgreSQL 的 SQL、PL/pgSQL、角色权限、RLS、外键和延迟约束触发器。`pnpm test:db` 的 **118 条数据库断言全部通过**，包含在已有数据上应用增量迁移；以 `node scripts/db-security.mjs --schema` 测试当前完整结构时，同样 118 条全部通过。测试数据仅存在于内存，退出后销毁，不读写商户数据，不需要数据库密码、网络或 Docker。

目标云项目已通过 `scripts/cloud-public-check.mjs` 的 **8/8 项真实未登录 HTTP 检查**：五张业务表读取与两个 RPC 均拒绝匿名访问，公开 Auth settings 显示邮箱认证、注册及邮件确认开启。测试仅用公开 publishable key，不带用户 JWT，没有创建账号或发送邮件。

**尚未进行两个真实账号 JWT 的跨商户读写隔离测试**，也未验收实际注册邮件、邮箱确认跳转、密码登录、找回密码或双连接并发。本机断言和云端匿名检查不能代替这些已登录流程验收；上线开放真实商户前仍需补齐，并检查 Auth redirect URL 和云端安全顾问结果。

迁移文件均通过官方 CLI 的 `migration new <name>` 生成，未手工构造文件名。已应用的初始迁移保持原样，SHA-256 为 `353f7b1660eb652e7e750bf97c9006c870747d0f38b81bdceca34d20436c70b9`；当前 `schema.sql` 已包含后续修复，因此不再与初始迁移逐字相同。不要把初始结构重复应用到已有表或已有数据的数据库，也不要在同一项目既手动执行完整 schema 又执行同内容迁移链。

新增迁移解决真实回归：历史销售原本包含 A、B 两行，B 后来停用；编辑移除 A 时，前端数组把 B 移到第一行，旧 RPC 按行号更新会把它误判为引入停用商品并拒绝。现在按商品身份一对一匹配并保留原明细 ID，行号仅表示排序；`(sale_id, line_number)` 唯一约束在提交时检查，允许事务内交换位置。停用守卫仍禁止新插入停用商品或把其他明细改成停用商品，也禁止复制已有停用行。此增量迁移仅更改约束、不可变字段触发器参数和 `save_sale` 函数，不更新经营数据。云端应用结果须另外核实，不能以本机通过代替。

## 表和权限

保留设计中的五张表：`shops`、`products`、`sales`、`sale_items`、`expenses`。固定一个账号一家店，店铺 `owner_id` 唯一。所有业务表显式启用 RLS，并且同时部署表 GRANT。`anon` 无经营表或 RPC 的访问权限。

`authenticated` 可读、插入、更新属于自己店铺的数据，只有销售明细有物理 DELETE 权限，用于原子编辑。商品和费用通过 `deleted_at` 停用；销售通过 `voided_at` 作废。店铺、商品、单头、费用不向客户端授权物理删除。UPDATE 策略同时含 `USING` 与 `WITH CHECK`；任何授权判断都不读取用户可编辑的 `user_metadata`。

商品和单头均有 `(shop_id, id)` 唯一键；明细同时以 `(shop_id, sale_id)`、`(shop_id, product_id)` 建立复合外键，防止把自己的销售关联到别人的商品。触发器拒绝更改 `id`、`shop_id`、店铺 `owner_id` 和 `created_at`；销售创建 `request_id`、`request_payload` 也不可变。

全部函数均为 `SECURITY INVOKER`，固定空 `search_path` 并对业务表使用限定名。RPC 只授予 `authenticated` 执行权。触发器辅助函数撤销 PUBLIC、anon 和 authenticated 的直接执行权限，触发器本身仍按调用者权限运行。浏览器只能使用 publishable key；任何 `service_role`、secret key 都不属于客户端配置。

## 金额与提交完整性

售价、实收、费用存储整数分 `bigint`，售价范围 `0..100000000` 分；单位成本使用整数厘 `bigint`，范围 `0..1000000000` 厘（最多三位小数）。每条明细先按数量计算厘成本，再四舍五入到分，然后汇总；数量为整数 `1..100000`；一单最多 100 行。每单含额外收入的销售收入、每单销售成本分别不超过 `1000000000000` 分。费用金额范围 `1..1000000000000` 分。

销售和费用的 INSERT、UPDATE 均由数据库触发器按 `clock_timestamp() AT TIME ZONE 'Asia/Shanghai'` 校验 `business_date`，拒绝晚于上海今天的日期。该校验也覆盖通过 RPC 保存销售的路径，不依赖浏览器日期或随时间变化的 CHECK 约束。

`sales_complete`、`sale_items_complete` 为 `DEFERRABLE INITIALLY DEFERRED` 的约束触发器：在事务提交时检查每张有效销售至少有一行，以及汇总金额上限。因而直接通过 Data API 分两次提交“先单头、后明细”会在第一次提交失败；删除唯一一条明细也会失败且回滚。新增和编辑必须通过一次原子 RPC 保存。明细修改前锁定父单，避免并发分行写入绕过金额上限。

历史金额始终取 `sale_items.unit_sale_price_cents` 和 `unit_cost_mills`。商品当前名价调整不会更新历史快照。已停用商品不能新增销售；编辑可保留原明细 ID 对应的停用商品、重排位置并纠正数量或实际价格；不能新增、复制或用无关停用商品替换。已经从单据移除的停用行不能在后续编辑中重新引入。已作废单及其明细不可恢复或修改。

## 前端字段契约

成本精度升级保留旧 `*_cost_cents` 列作为兼容舍入值，真实成本以新 `*_cost_mills` 为准。迁移在单事务锁表下按旧成本 ×10 回填，保持旧字段、历史快照、作废状态、时间、版本和原始创建请求内容不变。旧客户端不能把三位成本覆盖为两位；遇到此类记录需刷新网页。完全相同的旧创建请求仍可幂等重试，不能因为商品当前成本变化而重复记账。

前端升级后备份格式为 `schemaVersion: 2`、`unitCostScale: 1000`，商品为 `costMills`，销售成本快照为 `unitCostMills`。收入和费用字段仍为分。不删除旧成本列；有非整分厘成本时禁止数据库降级丢弃精度。回滚网页时保留数据库兼容保护。

商品写入字段：

```text
id, shop_id, name, category,
purchase_unit_cost_mills, sale_unit_price_cents, deleted_at
```

费用写入字段：

```text
id, shop_id, business_date, category, amount_cents, note, deleted_at
```

费用 `category` 仅接受：`transport`、`packaging`、`loss`、`utilities`、`rent`、`other`。所有日期由经营日期 `business_date` 统计，默认采用上海日期，不用 `created_at` 代替补录日期。

### `save_sale`

```typescript
supabase.rpc('save_sale', {
  p_id: saleId,                      // 客户端预生成 UUID；新增重试保留
  p_business_date: '2026-10-15',
  p_extra_income_cents: 100,         // 整数分；一单一次
  p_note: '配送费',                  // string 或 null，最多 500 字
  p_items: [{
    productId: productId,
    name: '薯片',                    // 名称快照，1..120 字
    category: '零食',                // 类别快照，1..40 字
    quantity: 2,
    unitPriceCents: 350,             // 实际售价快照
    unitCostMills: 2000,             // 实际成本快照，2000厘=2元
  }],
  p_expected_version: null,          // 新增为 null 或 0；编辑为当前 version
  p_request_id: requestId,           // 创建时生成的 UUID；编辑仍传原值
})
```

返回 JSONB **单头行**，包含 `id`、`shop_id`、`business_date`、`extra_income_cents`、`note`、`request_id`、`request_payload`、`version`、`version_transaction_id`、`voided_at`、`created_at`、`updated_at` 等。明细另从 `sale_items` 按 `shop_id` 和 `sale_id` 查询，按 `line_number` 排序。`version_transaction_id` 是数据库内部同步字段，前端忽略，不作为编辑参数。设计预留的 `extra_income_note` 在表中保留，本版 RPC 未暴露单独编辑字段，额外收入说明写入整单 `note`。

新增保存 `(shop_id, request_id)` 唯一创建请求，使用事务级 advisory lock 串行处理同一创建请求。相同 ID、请求标识和 JSONB 负载重试返回现有单头；相同请求标识携带不同内容或单据 ID 返回冲突。创建请求指纹不可变，之后编辑不会重写。

编辑先锁销售单，再验证 `version`；成功则单头版本加 1。RPC 按 `product_id` 为每条输入匹配一条尚未使用的原明细，保留其 ID 并更新排序和快照；匹配不到才执行受停用守卫保护的 INSERT，最后删除未保留行。同一商品原有多行时一对一匹配，不允许用一条历史停用明细匹配多条新输入。编辑不提供独立的请求幂等 token，重复提交旧版本会得到冲突；前端收到成功后重新加载，遇到不确定的网络结果应刷新确认版本，不能自动以新版本覆盖。应用正常保存入口统一使用 RPC。

直接写入 `sale_items` 同样会使已打开的旧编辑失效：单头内部字段 `version_transaction_id` 使用 PostgreSQL `xid8` 类型，由触发器在每次单头 INSERT、UPDATE 时强制写入 `pg_current_xact_id()`。明细改动前锁住父单，如果父单尚未在本事务修改，就先递增其 `version`；同一事务的后续明细不再重复递增。RPC 编辑先改单头，因而无论包含几条明细，成功仍只加一次版本。试图仅伪造事务戳而不递增版本会被单头版本保护拒绝。RLS、复合外键和提交完整性约束仍同时生效。

### `void_sale`

```typescript
supabase.rpc('void_sale', { p_id: sale.id, p_expected_version: sale.version })
```

返回更新后的单头 JSONB。版本不符拒绝；成功作废使 `voided_at` 非空，版本加 1。看板必须排除作废单。已作废单如再次携带当前版本调用会返回该行，不重复加版本。

常见数据库错误：`42501` 权限拒绝，`23503` 商品/单头不存在或不同店，`23514` 字段或提交完整性约束，`23505` 唯一键/幂等内容冲突，`40001` 编辑版本冲突，`P0002` 当前账号下单据不存在，`22023` RPC 输入格式错误。

## 本机安全回归

```powershell
Set-Location -LiteralPath '<你的项目目录>'
pnpm test:db
node scripts/db-security.mjs --schema
```

测试用 `auth.users` 最小替身及从 `request.jwt.claims` 读取 sub 的 `auth.uid()`，以 `SET LOCAL ROLE authenticated/anon` 模拟权限，**不使用表所有者身份证明 RLS**。118 条断言验证五表隔离、返回零行的跨账号更新、跨店关联和身份字段篡改、禁止物理删除、空单与最后一条明细的 COMMIT 回滚、整数范围、原子回滚、幂等、旧版本冲突、快照、停用商品、作废单和另一店数据未变；还验证六种未来日期写入场景、直接修改明细的版本同步、防伪造事务戳，以及 PUBLIC/anon 无函数执行权、authenticated 只可直接执行两个预期 RPC。

默认路径先运行初始迁移及原有 87 条回归，再在已有数据上运行增量迁移并核对所有经营行和函数权限；随后验证停用商品压缩位置、插入前行、交换排序、保留修正快照、拒绝无关停用商品和重复停用行、失败编辑完整回滚、最终行号唯一及移除后不得重新引入。`--schema` 则直接安装当前完整结构，执行相同业务与安全断言。

PGlite 是单连接的嵌入式 PostgreSQL：已验证行锁 SQL 和冲突规则能够执行，未模拟两个独立 Postgres 会话的真实并发竞争。上线前应在隔离的 Supabase 测试项目执行双会话并发和真实 Auth + Data API 回归，并跑安全顾问。

## 云端公开接口回归

```powershell
Set-Location -LiteralPath '<你的项目目录>'
node --env-file=.env.local scripts/cloud-public-check.mjs
```

脚本限定目标 HTTPS 项目为 `nporrbvnaezafvryjqao`，仅读取 `.env.local` 中的 `NEXT_PUBLIC_SUPABASE_URL` 与 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`。所有请求只带公开 apikey；不带用户 JWT、不使用管理员 key，也不输出凭据。

本轮 **8/8 通过** 的范围如下：

| 检查 | 实际验证内容 |
| --- | --- |
| `shops`、`products`、`sales`、`sale_items`、`expenses` 五表 | 未登录 GET 不可读取经营数据；数据库权限拒绝 |
| `save_sale`、`void_sale` 两个 RPC | 未登录调用返回权限拒绝，未写入或作废记录；探针参数也不具备可持久化业务内容 |
| `/auth/v1/settings` | 返回 HTTP 200，`external.email=true`、`disable_signup=false`、`mailer_autoconfirm=false` |

Auth settings 只证明公开配置符合预期，不能证明邮件能投递或商户能成功完成注册。两个真实商户会话的 RLS 验收仍待执行。可在 Dashboard 的 Authentication → Users → Add user → Create new user 中创建两条专用测试账号并勾选 Auto confirm user；官方该表单不发送确认邮件，无需关闭项目的全局邮箱确认。也可用服务器专用 secret key 通过 `auth.admin.createUser({ email, password, email_confirm: true })` 建立测试账号，随后所有业务测试改用 publishable key 和真实密码登录会话。不要用直接 INSERT Auth 内部表代替官方管理入口。

真实 Auth 和 PostgREST 使用独立连接，不能用同一个未提交 SQL 事务包住整轮 HTTP 测试后回滚。测试完成应按精确测试用户和店铺 UUID 清理，避免使用无条件全表删除。本项目禁止删除已作废销售明细，故隔离回归的待清理销售应保持有效，按 `sale_items → sales → expenses → products → shops → auth.users` 清理。先退出测试会话并丢弃 token；已经发出的访问 JWT 不会因删除用户立即失效。

## 已核对的官方资料

- [Supabase RLS：显式授权、每操作策略、UPDATE 前后检查](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase 数据库函数：调用者权限和函数授权](https://supabase.com/docs/guides/database/functions)
- [Supabase API 安全](https://supabase.com/docs/guides/api/securing-your-api)
- [2026 年 Data API 自动暴露规则变更](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
- [PostgreSQL 约束触发器和延迟执行](https://www.postgresql.org/docs/current/sql-createtrigger.html)
- [PostgreSQL 事务 ID 信息函数](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-PG-SNAPSHOT)
- [Supabase 官方集成测试：创建已确认测试账号](https://supabase.com/docs/guides/local-development/testing/overview)
- [Supabase Studio 创建用户表单源码](https://github.com/supabase/supabase/blob/master/apps/studio/components/interfaces/Auth/Users/CreateUserModal.tsx)
- [Supabase Auth 排障：直接 SQL 插入用户可能导致字段不兼容](https://supabase.com/docs/guides/troubleshooting/database-error-saving-new-user-RU_EwB)

已尝试读取官方 changelog Markdown 索引，网页工具返回不支持的 MIME，终端网络权限也拒绝了请求；因此核对官方 changelog 网页和相关 Breaking Change 页面。当前实现不依赖 pgcrypto 或非默认扩展；使用内建 `gen_random_uuid()`。
