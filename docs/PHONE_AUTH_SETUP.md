# 小店利润本：手机验证码登录配置

> 已归档：本文保留早期设计、部署或验收记录，文中状态仅对应记录日期。当前功能和使用方法以 [README](../README.md) 与仓库代码为准；新环境的服务配置、价格和可用性请重新核对。

2026-10-20当前状态：前端已通过香港`https://api.lirunben.cn`代理访问原Supabase，三阶段上传的59文件全部通过公开HTTPS哈希核验；本机`.env.local`已同步API地址和旧会话存储键，原publishable key保留。00:16的v15 claim超时后，`send-auth-sms` v16已部署ACTIVE，保留4500ms总预算、claim默认2000ms、供应商前finish预留600ms、未知状态不发送及无自动重试。`verify_jwt=false`配合函数内Webhook签名验证保留，无签名首尔探测401。用户现已确认原故障手机“收到并登录成功”，刷新页面后仍保持登录，商品管理和销售记录页面正常。安全日志已确认OTP、Hook、verify、user及shops成功；令牌到期自动刷新、写入、双账号隔离及邮件回跳仍待独立验收。发布及00:16历史失败细节见[API入口记录](API_CONNECTIVITY_REPAIR_PLAN.md)。

成功请求的安全日志（北京时间2026-10-20）：11:59:25 `POST /auth/v1/otp` 200；11:59:30 首尔Hook v16 200、执行3533ms；11:59:39 `POST /auth/v1/verify` 200、`GET /auth/v1/user` 200；11:59:40及12:00:15 `GET /rest/v1/shops` 200。只核对路径、状态、区域和耗时，未读请求体、OTP、JWT或账本内容。商品及销售页面正常由用户确认，未从日志核验其数据请求；尚未观察或验证refresh_token grant。

2026-10-19历史排查：发送函数v15的claim上限为1000ms。新加坡及东京无短信HEAD探针出现过5秒连接超时，首尔9次为118～992ms；Send SMS Hook URL增加`?forceFunctionRegion=ap-northeast-2`后，12:39:23一次真实请求Auth和发送函数均200，首尔函数耗时2609ms，用户确认收到。该次账号创建后输入验证码登录仍待验证。另一台手机随后无法打开Supabase健康检查，普通浏览器同样失败；后续香港API入口已使该手机健康检查可达。固定区域故障仍须人工调整，不视为自动跨区容灾。详细记录见`artifacts/SMS-TIMEOUT-2026-10-19.md`；下方v11描述为最初上线历史。

2026-10-17历史验收：v1.2.0保留邮箱登录，构建配置启用手机验证码入口。**手机入口由构建变量 `NEXT_PUBLIC_PHONE_AUTH_ENABLED` 控制。** 阿里云号码认证服务按用户授权开通，专用RAM用户仅获`dypns:SendSmsVerifyCode`权限。此前发送凭据格式问题修复后，用户曾在本机网页连接原生产Supabase/PNVS后端，确认“收到短信并登录成功”。该历史结果不等同于2026-10-20新API路径的验收。Hook密钥、防重复后端及数据库迁移已配置，验证码六位、有效期300秒、要求手机确认；当时总短信上限10条/小时已刷新核对保存，当前限流以项目配置为准。真实双账号隔离等项目仍待验收。

## 接入方式与费用

当前流程为：前端 → 阿里云香港API代理 → 原Supabase Phone OTP → Supabase生成验证码 → HTTP Send SMS Hook → 首尔`send-auth-sms` Edge Function → 阿里云号码认证服务`SendSmsVerifyCode` → 用户经香港代理向Supabase提交验证码。验证码、会话及账本权限仍由原Supabase验证；代理未配置服务密钥。邮箱登录和现有SMTP配置保留，邮箱确认/找回密码邮件链接目前仍指原Supabase，其可达性和回跳须独立验证。[Supabase 手机登录](https://supabase.com/docs/guides/auth/phone-login)、[Send SMS Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook)

使用阿里云 **号码认证服务（PNVS）的短信认证 API**，个人开发者可使用其系统赠送的签名和配套模板。该服务使用 `dypnsapi.aliyuncs.com`，需要用户本人完成开通和身份要求。它与通用短信服务的接口、模板和套餐独立。[个人开发者接入指南](https://help.aliyun.com/zh/pnvs/use-cases/sms-verify-for-individual-developers)

官方当前公示：短信认证 API 月用量不超过 1,000 次时，按量单价为 **¥0.06/次**，按运营商回执状态计费。本次未代用户充值或购买套餐；真实短信已经投递，可能产生按量费用，实际金额以供应商账单为准。开通和预算由用户本人决定。[号码认证服务价格](https://help.aliyun.com/zh/pnvs/product-overview/product-pricing/)

现有Supabase项目位于Singapore，发送Hook固定首尔。2026-10-17旧路径及2026-10-20 API/v16路径均有用户确认的收码与登录结果；当前手机刷新页面后仍保持登录，商品和销售页面正常。这些单次成功不代表所有号码、运营商或后续请求均能送达。通用SMS产品的境外出口限制不能直接套用为本PNVS个人方案的结论。[通用 SMS 使用说明](https://help.aliyun.com/zh/sms/product-overview/faq)

## 已实现的后端边界

入口为 `supabase/functions/send-auth-sms/index.ts`，业务处理位于同目录 `handler.ts`。固定依赖为 `standardwebhooks@1.1.1` 和阿里云官方 `@alicloud/openapi-core@1.0.8` 签名器，分别校验 Standard Webhooks 签名、时间戳及构造 ACS3 签名。只有合法签名与有效参数才能进入供应商发送流程。v16处理总预算为4.5秒，claim HTTP默认上限2000毫秒；供应商使用剩余预算并预留finish的600毫秒，仍受全局deadline约束。更长claim只增加跨区冷连接余量，也会压缩供应商剩余时间，不保证任意冷请求成功。[Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks)、[阿里云签名规范](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature)

Auth 的网络重试可能换用新的 webhook ID，而保留相同请求体。因此去重标识使用服务端内置密钥对已验签请求体计算 HMAC，不依赖 webhook ID。私有表 `auth_sms_private.sms_deliveries` 仅保存摘要、租约编号、状态与时间，不保存手机号、验证码或请求体。两个 RPC 都是 `SECURITY INVOKER`，只授予 `service_role` 执行权限；匿名和已登录商户均不能调用。[Auth HTTP Hook 重试实现](https://github.com/supabase/auth/blob/3ca1e88df06e7096c8ebb3e1bedf291654f4c66e/internal/hooks/hookshttp/hookshttp.go)

45 秒租约覆盖 Auth 的 5 秒自动重试窗口。已发送请求的重复调用直接确认成功；处理中或结果不确定时拒绝再次发送。旧租约不能覆盖新租约。它允许稍后的正常重发，**不承诺阻止整个五分钟验签窗口内的人工重放**，也不能证明运营商最终送达。数据库不可用或结果不明时不调用供应商。数据库函数另设短锁等待与语句超时；客户端中止请求不能单独证明数据库已取消。

后端仅接受中国大陆 `+86` 手机号和六位数字验证码，兼容 Supabase 内部去掉 `+` 后的 `861…` 表示。较新 Hook 的 `sms.phone` 优先作为实际目标号码，缺失时使用 `user.phone`，避免手机号变更时发到旧号码。[Supabase 手机号规范化源码](https://github.com/supabase/auth/blob/master/internal/api/phone.go)

`TemplateParam.code` 直接填写 Supabase 的 `sms.otp`，保留前导零；不使用 `##code##` 让供应商另生成验证码，也不调用阿里云验证码核验接口。认证与验证码校验由 Supabase 完成。供应商只有 HTTP 成功且业务 `Code=OK`、`Success=true` 时才返回空 JSON；其余失败返回 Hook 错误。API 接受请求仍须以实际手机收信验证投递。[SendSmsVerifyCode 参数](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)

实现不记录手机号、OTP、密钥或供应商原始响应，错误统一脱敏。供应商请求 URL 中包含 API 查询参数，排障时也不要记录完整 URL、请求头、请求体或原始异常。超时后结果可能不确定，应核对供应商状态，避免连续重发。

## 先运行离线回归

从项目根目录执行以下跨平台命令，依赖仅装入后端 QA 目录，不加入网站运行依赖：

```sh
pnpm --dir supabase/functions/send-auth-sms/qa install --ignore-workspace --frozen-lockfile --ignore-scripts
node --experimental-strip-types --test scripts/test-auth-sms.mjs
pnpm test:auth-sms-db
```

`qa/package.json` 和 `qa/pnpm-lock.yaml` 固定上述官方依赖。测试默认从该 QA 目录解析依赖；已有隔离安装时，可以用非敏感环境变量 `SMS_QA_ROOT` 指向包含同版本 `package.json` 和依赖的目录。无需设置云端变量或读取 `.env.local`。

当前62项离线短信测试通过，使用真实Standard Webhooks库及阿里云SDK签名器，网络请求全部为本地模拟。覆盖指定OTP、ACS3签名向量、拒签、过期、篡改、密钥轮换、号码限制、供应商失败、脱敏、同体不同ID重试、并发模拟、未知状态及截止时间；新增默认1200ms冷claim成功仅发送一次，以及超出新cap后abort、无重试、迟到commit仍不发送。此前44项PGlite数据库检查与新装/升级定义等价检查覆盖真实SQL、租约、状态及权限，本次未修改数据库。PGlite使用单连接，不能替代真实PostgreSQL多会话锁竞争或PostgREST超时生效测试。这些检查不发送短信，也不能替代云端及手机验收。

API公开检查脚本现已支持固定API地址，仅顺序GET/OPTIONS、无自动重试，6项离线测试通过；随后单次线上复验12/12通过，5表均401/42501，合法预检204、非法Origin403、无JWT用户401、三个禁用路由404。此前初版12并发超过FC单实例5并发导致429，已改为顺序检查，未扩容或隐藏限流。公开检查不请求生产短信、登录或写RPC，也不证明真实JWT跨账号隔离。代理出口IP会汇集上游Auth的IP限流，429须与网络失败区分，实际短信及Auth配额以当前项目为准。应用默认`pnpm test`不包含需另装依赖的后端集成；单独运行上述命令。

## 仅配置到 Edge Function 的服务器变量

通过 Supabase Edge Functions 的 Secrets 配置以下变量。不要写到网站 `NEXT_PUBLIC_` 变量、Git、聊天或截图中。防重复发送使用 Edge Runtime 自动注入的 `SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 调用仅服务器可执行的 RPC；无需用户额外复制这些内置变量，绝不能将它们放进前端。签名密钥由用户本人输入和保存。

| 变量                       | 必填 | 内容                                                                                  |
| -------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `SEND_SMS_HOOK_SECRET`     | 是   | Supabase HTTP Hook 签名密钥，完整 `v1,whsec_…` 格式；支持用 `\|` 分隔新旧密钥进行轮换 |
| `ALIYUN_ACCESS_KEY_ID`     | 是   | 有权调用 PNVS 的服务器 AccessKey ID                                                   |
| `ALIYUN_ACCESS_KEY_SECRET` | 是   | 与 ID 对应的服务器 AccessKey Secret                                                   |
| `ALIYUN_SECURITY_TOKEN`    | 否   | 使用临时 STS 凭据时配套的安全令牌                                                     |
| `ALIYUN_SMS_SIGN_NAME`     | 是   | PNVS 控制台实际可用的系统赠送签名                                                     |
| `ALIYUN_SMS_TEMPLATE_CODE` | 是   | 与该签名配套的 PNVS 赠送模板代码                                                      |
| `SMS_OTP_TTL_SECONDS`      | 否   | 默认 `300`；须为 60～3,600 秒内的整分钟，并与 Supabase SMS OTP 过期时间一致           |

模板应包含 `code`、`min` 参数；使用控制台实际给出的配套模板，不能把普通 SMS 的模板填到这里。RAM 最小调用权限为 `dypns:SendSmsVerifyCode`，资源 `*`；由用户本人准备适用的 RAM 或 STS 凭据。[API 授权与模板参数](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)

## 部署与启用顺序

当前`send-auth-sms`为云端v16、状态ACTIVE，首尔无签名POST返回401；继续使用`verify_jwt=false`及函数内Standard Webhooks签名验证。Send SMS Hook URL固定首尔区域，当前API路径的真实收码、输入验证码登录、刷新页面保留登录状态及商品/销售页面正常，已由用户确认。安全服务端日志同时确认本次OTP、v16 Hook、verify、user及shops成功，详见文首记录。

2026-10-17历史部署：防重复版本为v11；`auth_sms_delivery_claims`云迁移版本为`20261017023656`（本地CLI文件为`20261017022705_auth_sms_delivery_claims.sql`）。当时验证两项RPC均为invoker且仅服务角色可执行、私有表RLS开启，六项SQL状态断言在回滚事务内通过，两个匿名短信RPC返回401/42501，无签名公网POST返回401，安全Advisor无告警。公开Auth settings曾确认phone=true、email=true、anonymous_users=false，用户在本机连接原后端完成一次收码与登录。下列顺序保留供新环境部署使用，历史结果不替代v16/API路径验收。

1. 保持网站 `NEXT_PUBLIC_PHONE_AUTH_ENABLED=false`。由用户本人完成 PNVS 服务开通、选择赠送签名和模板、准备发送凭据及预算。
2. 在 Supabase 的 **Authentication → Hooks → Send SMS** 准备 HTTP Hook URL 与签名密钥，先不启用 Hook。函数 URL 为 `https://<项目引用>.supabase.co/functions/v1/send-auth-sms`。把相同签名密钥和上述服务器变量填入 Edge Functions Secrets。
3. 先部署数据库迁移并核对两项短信 RPC 只有服务角色可执行，再部署 `send-auth-sms`。关闭该函数网关的 JWT 校验，改由函数内的 Standard Webhooks 签名验证请求。部署前查看当前 CLI 帮助；支持该参数的 CLI 可使用：

   ```sh
   supabase functions deploy --help
   supabase functions deploy send-auth-sms --project-ref <项目引用> --no-verify-jwt
   ```

   等效配置为 `[functions.send-auth-sms]` 下 `verify_jwt=false`。这只适用于本签名 Hook，不能去掉处理函数中的签名校验。[Edge Function 配置](https://supabase.com/docs/guides/functions/function-configuration)、[外部签名 Webhook](https://supabase.com/docs/guides/functions/auth)

4. 在尚未启用 Hook 时，先用不含签名、不含手机号的请求检查公网函数拒绝匿名发送；预期 HTTP `401`，不能返回成功：

   ```sh
   curl -i -X POST "https://<项目引用>.supabase.co/functions/v1/send-auth-sms" -H "Content-Type: application/json" --data "{}"
   ```

5. 部署和拒绝匿名检查通过后，再在 **Authentication → Hooks** 启用 Send SMS HTTP Hook，核对 URL 与密钥。在 **Authentication → Sign In / Providers → Phone** 启用手机认证，保持手机确认开启、自动确认关闭；设置 OTP 长度 `6`、过期 `300` 秒或与服务器配置一致的值。邮箱提供商保持启用。此 Hook 替换内置供应商发送，无需另外开通 Twilio 或向普通 SMS 填入凭据。[手机认证设置](https://supabase.com/docs/guides/auth/phone-login)、[Hook 发送路径源码](https://github.com/supabase/auth/blob/master/internal/api/phone.go)
6. 核对 Supabase SMS 发送频率限制、验证码重试限制与 CAPTCHA，设置合理的小额发送预算。不要通过自动确认或固定测试 OTP 绕过真实验证。
7. 用户明确同意实际短信费用后，再用本人有权使用的号码做一次真实联调。成功后才将 `NEXT_PUBLIC_PHONE_AUTH_ENABLED=true`，重新构建和部署网站；该变量会在构建时进入前端，仅控制入口显示，不代替后端认证。

## 当前发布的验收状态

- [x] 2026-10-17旧路径：Singapore生产后端调用PNVS，用户确认收码并使用正确验证码建立会话。
- [x] 2026-10-20新API路径：原故障手机健康检查ok:true，已发布前端59项公开哈希一致。
- [x] 2026-10-20 v16及新API路径：原故障手机收到短信并输入正确验证码登录，用户确认。
- [x] 用户刷新页面后仍保持登录，商品管理和销售记录页面加载正常。
- [ ] 令牌到期后的refresh_token grant及账本写入，尚未独立验证。
- [ ] 错误、过期或已用验证码被拒绝，倒计时与再次发送规则正常。
- [ ] 邮箱注册和密码登录仍可用；既有邮箱用户不会因为手机号相同就自动合并账号或迁移账本。
- [ ] 两个真实手机或邮箱身份创建各自店铺，使用真实 JWT 验证跨店读取和修改均被拒绝。
- [ ] 费用、发送统计、失败诊断及限流能正常核对，排障记录不含完整号码、OTP、密钥或签名请求。

服务开通、服务器凭据和签名密钥配置、防重复后端及API前端发布已完成；v16上线后，用户确认原故障手机收码、输入验证码登录、刷新页面保持登录，商品及销售页面正常。令牌到期后的refresh_token流程、账本写入、真实双账号JWT隔离、错误或过期验证码、费用与限流尚未完整实测。邮箱登录保留，真实注册确认与找回密码邮件送达及原Supabase链接可达性仍待验收。已有邮箱账本的商户应继续使用邮箱登录；单独注册的手机号账号不会自动合并或迁移旧账本。API独立TLS证书仍需手动续期并重新部署，详见[API入口记录](API_CONNECTIVITY_REPAIR_PLAN.md)。
