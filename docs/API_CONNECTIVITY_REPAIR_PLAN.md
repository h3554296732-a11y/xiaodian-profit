# 手机无法直连后端：香港 API 入口部署进度

> 已归档：本文保留早期设计、部署或验收记录，文中状态仅对应记录日期。当前功能和使用方法以 [README](../README.md) 与仓库代码为准；新环境的服务配置、价格和可用性请重新核对。

更新：2026-10-20。状态：香港 FC 代理及 `api.lirunben.cn` 自定义域名已部署，用户分三阶段上传的前端59文件全部通过公开HTTPS哈希核验。`.env.local`已同步API地址与原会话存储键，公开key保留。00:16的短信Hook v15 claim超时后，v16已部署ACTIVE；用户现已确认原故障手机“收到并登录成功”，刷新页面后仍保持登录，商品管理和销售记录页面正常。安全日志同时确认OTP、v16 Hook、验证码验证、用户及店铺读取均成功，详情见下方记录；令牌到期后的refresh_token流程、写入、双账号隔离和邮件回跳仍待独立验收。

## 现象与已完成的修复

2026-10-19，发送函数到阿里云 PNVS 的连接超时曾通过无短信探针复现；Send SMS Hook 固定首尔后，一次真实新号码请求在2609ms内成功，用户确认收到。此后另一台手机在微信、普通浏览器均无法连接 Supabase，直接打开项目 `/auth/v1/health` 也提示检查网络，相应新请求没有出现在 Auth/网关日志。当时未确定具体DNS、TLS或运营商原因；随后新增香港API入口，原失败手机已确认新入口可达。2026-10-20的claim超时另有服务端日志证据，不能继续归因为手机网络失败。

## 部署方案与当前配置

- 浏览器 → `https://api.lirunben.cn` → 阿里云 FC 中国香港 Web 函数 → 原 Supabase 新加坡项目。数据保留在原项目，Auth/RLS继续授权。
- 代码：`deployment/supabase-proxy/server.mjs`，零第三方运行依赖，Node内建HTTP/fetch，监听`0.0.0.0:9000`，启动`node server.mjs`。需要覆盖认证、验证码验证、会话刷新及经营数据；不只代理发短信。
- 固定上游；仅当前Auth、5张业务表及2个销售RPC白名单。无任意网址代理、服务密钥、数据库密码、短信凭据、自动写重试、响应缓存或敏感请求日志。
- 浏览器原有手机号、OTP、密码、用户访问/刷新令牌及业务请求会经用户自己的阿里云FC转发给原Supabase；代理不持久保存这些内容。用户已明确批准此新增处理路径。
- 已创建香港 `cn-hongkong` 函数 `api-proxy`，自定义 Node.js 22 Debian 11 运行时，0.10 vCPU、128 MB 内存、512 MB 临时磁盘；最小实例0、最大弹性实例1、单实例并发5、函数超时20秒。启动命令 `node server.mjs`，监听9000端口。未接入VPC，公网出网开启，SLS日志和链路追踪关闭；未使用GPU、常驻资源池、付费套餐或容器镜像。
- HTTP触发器经用户单独确认后设为“无需认证”，允许 `GET, POST, PUT, HEAD, OPTIONS, PATCH`，已去除DELETE。Supabase用户令牌验证和RLS继续生效，公开触发器不授予数据库权限。
- 默认测试入口使用云控制台为当前函数生成的域名；`GET /healthz` 应返回200和固定版本标识。`PROXY_PUBLIC_HOSTS` 应填写自己的API自定义域名、该精确测试域名，以及按需保留的 `127.0.0.1:9000,localhost:9000`；生产不配置额外本地Origin。不在此函数中配置Supabase密钥、数据库密码或短信凭据。
- API自定义域名使用独立HTTPS证书，并通过阿里云证书服务导入。签发时复用已有免费证书账户，使用仓库外的隔离输出目录，不覆盖根域名证书。证书有效期和SHA256指纹应在部署时记录并核对；历史部署未配置自动续期。
- FC自定义域名将 `/*` 路由到API代理函数的指定版本，强制HTTPS，最低TLS1.2并启用TLS1.3，域名认证为无需认证，CDN关闭。DNS的CNAME目标必须使用云控制台为自己的账号实际提供的值，不复制其他环境的账号或资源标识；历史配置采用TTL10分钟、权重1。
- 香港FC自定义域名无需ICP备案。默认触发器域名仅作测试；API自定义域名的正常TLS及原失败手机健康检查已通过，正式前端已切换。
- 生产构建及本机`.env.local`均设置`NEXT_PUBLIC_SUPABASE_URL=https://api.lirunben.cn`与`NEXT_PUBLIC_SUPABASE_STORAGE_KEY=sb-nporrbvnaezafvryjqao-auth-token`，保持原publishable key，保留同一项目既有会话的存储键。后续普通构建使用当前API配置；发布前仍需核对实际构建中的API地址和原会话键，避免外部构建环境覆盖本机设置。

## 权限与费用

用户已明确批准FC按量费用、数据转发路径及授权弹窗；控制台已确认创建`AliyunServiceRoleForFC`并附加`AliyunServiceRolePolicyForFC`。弹窗说明涉及访问VPC、ECS、SLS、镜像服务等资源，以完成函数VPC互通、镜像下载、资源回收、日志导出、函数管理和会话管理。此代理本身未绑定函数角色或配置云服务凭据。公开HTTP触发器的修改另有用户明确确认。

FC是新增按量计费产品。官方当前首档为0.00011元/CU；2026-08-27结束的八折活动不用于估算。最小实例0且无调用时不计计算费；有调用的小时单函数至少0.01元，超过则按实际计量。每日8小时有调用、30天且每小时实际计算费低于最低档时，计算费参考为2.40元/月；24小时每天均有调用时最低档为7.20元/月。公网出流量另由CDT计量，可能有跨产品共享免费额度，但未核实本账户资格/剩余额度。以上不是封顶价，不承诺永久免费。新客试用包未领取，未假定本账户有权益。

## 验证与切换

1. 本地21项HTTP/mock测试通过，覆盖凭据透传、固定路由、Host/CORS、缓存、禁止重试、大小和超时限制、HEAD/OPTIONS/204。独立审查使用当前SDK实际生成的19类请求均只向本地mock转发一次。未调用生产短信。
2. 低配FC及API自定义域名已部署；`https://api.lirunben.cn/healthz`返回200及固定版本标识，不探测Supabase或发送短信。正常TLS连接验证通过（authorized=true，协商TLS1.3，证书指纹与部署时记录一致），未跳过证书验证。自定义域名对 `Origin: https://lirunben.cn` 的OTP路径OPTIONS预检返回204及SDK所需请求头。用户已用原失败手机的原网络打开健康检查，并确认显示ok:true。
3. 默认测试域名及API自定义域名均已完成不发送短信的上游验证：无用户令牌的`GET /auth/v1/user`返回401，`GET /rest/v1/shops?select=*&limit=1`返回401/42501，正确保留后端权限拒绝；未返回账本数据。`/auth/v1/settings`等未列入代理白名单，不能将它们用作预期成功的健康接口。API前端构建前已通过TypeScript及20项手机号/密码恢复测试，隐私说明包含香港转发路径，连接错误文案为“暂时无法连接登录服务”；现已完成正式发布。
4. 发布后的手机验收已由用户确认：v16上线后，原故障手机收到短信、输入验证码登录成功；随后刷新页面仍保持登录，商品管理及销售记录页面加载正常。安全日志已确认OTP、Hook、verify、user及shops的成功状态；商品及销售页正常由用户确认，未声称对应数据请求已从日志核验。后续还须独立核验令牌到期后的refresh_token grant、账本写入及双账号隔离；邮箱确认/找回密码邮件链接目前仍指原Supabase，送达、可达性及回跳也未完成验收。
5. 原构建及原Supabase直连地址保留用于回滚；若当前发布回归失败，应按备份恢复前端配置并核对实际引用资源。停止使用FC时还需关闭公网触发及处理计费资源，不能只回退页面就留下无人管理的函数。

### 2026-10-19至20日发布与证书记录

- 已生成并校验59个候选文件，共1,339,034字节，全部页面引用的本地静态资源存在；候选JS包含API地址和原项目会话存储键。输出扫描未发现私钥或secret key值（SDK中仅有密钥类型前缀常量）。
- 发布来源目录：`artifacts/api-static-candidate-20261019/`；ZIP及逐文件SHA256清单同名前缀。ZIP SHA256为`34C426A5817E384497A1C15352FD229571BD3E482485186D00A345BC140BBDD7`。独立核验全部59项文件哈希与大小、ZIP内容及HTML资源引用通过；现已全部发布，线上59/59文件的公开HTTPS哈希与清单一致。
- 原59文件逐一哈希备份位于`artifacts/rollback-static-before-api-20261019/`。2026-10-19准备阶段曾将`out/`恢复原版；2026-10-20已将当前59文件同步为发布版，保留未被新页面引用的旧哈希资源和回滚备份。`.env.local`现已使用API地址与原会话键，根域名证书指纹保持原值。
- 此前DNS页面的DOM读取、截图与FC页面操作多次无响应，现浏览器操作已恢复；未通过其他浏览器或管理API绕过限制。用户已手动保存`_acme-challenge.api` TXT，Google和Cloudflare公共DNS均核验匹配。此前OSS自动操作的审批拒绝仍然有效，发布需要用户在OSS控制台完成手动上传。
- 本机到两家DNS-over-HTTPS服务的连接失败，原预检因此在CA挑战前停止。已加入仅在传输失败时使用固定Google/Cloudflare DNS的有限时备用查询，双方仍须完全匹配TXT；负响应不能触发备用。原27项加7项新增测试，共34项通过。之后恢复同一订单完成签发，未新增账户或重复订单。
- 证书与私钥保存在仓库外的受限目录，公开仓库不记录个人路径、证书资源ID或控制台证书名称。上传前应核对证书公钥与私钥匹配并限制目录访问权限。历史部署中，FC从CAS选择证书时拒绝PKCS8 RSA格式，因而将同一RSA私钥转换为PKCS1格式后手动导入；原密钥与证书保留，未重新签发。私钥内容不得写入仓库或命令输出。
- 原生系统域名解析、正常TLS和健康检查可用；向Google/Cloudflare公共DNS直接查询API的CNAME均返回ENODATA，尚未明确原因，不能称为“两家公共DNS已确认API CNAME”。此结果与已单独通过的ACME TXT验证分开记录。
- 用户已依次上传`artifacts/api-upload-1-assets/`的17个静态资源、`api-upload-2-data/`的32个TXT/RSC、`api-upload-3-pages/`的10个HTML；三阶段共59项公开哈希核验通过。首页及`/account/`、`/products/`、`/sales/`、`/expenses/`、`/privacy/`均返回200，新chunk和build资源可见；未知路由返回404，当前不存在的`/terms`返回404属预期。旧哈希资源保留以兼容已打开页面和回滚。
- 2026-10-20 00:16，用户一次真实OTP在上游返回500/`unexpected_failure`；首尔`send-auth-sms` v15执行1896ms、返回422，唯一安全诊断为`stage=claim, reason=timeout`，未进入供应商。已将默认claim HTTP预算从1000ms改为2000ms，仍受4500ms全局deadline及供应商前finish600ms预留限制，保持模糊失败关闭及不自动重试。原60项加2项默认预算回归共62项离线测试通过；v16已部署ACTIVE，`verify_jwt=false`配合函数内Standard Webhooks签名验证保留，无签名首尔探测返回401。用户随后确认原故障手机收到短信并输入验证码登录成功，刷新页面仍保持登录，商品及销售页面正常。
- 成功请求的安全日志（北京时间2026-10-20）：11:59:25 `POST /auth/v1/otp` 200；11:59:30 首尔Hook v16 200、执行3533ms；11:59:39 `POST /auth/v1/verify` 200、`GET /auth/v1/user` 200；11:59:40及12:00:15 `GET /rest/v1/shops` 200。核对仅使用路径、状态、区域及耗时，未读取请求体、OTP、JWT或账本内容。未从该日志确认products/sales数据请求或refresh_token grant。
- `scripts/cloud-public-check.mjs`已增加固定API模式，仅顺序GET/OPTIONS检查，逐项单次调用、无自动重试，6项离线验证通过。顺序版本单次线上复验12/12通过：5表均401且错误码为42501，合法预检204，非法Origin为403/`origin_not_allowed`，无JWT用户请求401，三个禁用路由均404。404单独验证代理路由边界，不能充当数据库RLS通过；公开检查只提供未登录边界证据，收码、登录和页面刷新结果另由用户确认。结果记录见`artifacts/api-release-state-20261020.json`。

## 已知运行边界

- 默认FC测试入口和API自定义域名均观察到网关补充CORS响应头：不允许的 `https://other.example` Origin 实测返回403，但网关仍附加该Origin的Allow-Origin和预检字段。应用在转发上游之前拒绝该Origin，未返回私有数据；仍须核对并关闭额外网关CORS处理（如控制台提供），不能仅根据响应头宣称网关也执行精确Origin白名单。
- 代理不信任客户端转发IP头；使用publishable key时，上游Auth的IP限流会汇集到FC出口地址。官方默认注册/登录组及验证各为每IP每5分钟30次，token每IP每5分钟150次，短信另有项目级每小时30条默认值，实际以本项目配置为准。低用量可保留当前保护；扩大使用前须核对容量和429回执，不能通过接收任意客户端IP头或提升代理凭据来绕过限流。
- 公开检查器初版立即发起12并发，曾超过FC单实例5并发而出现429；已改为顺序执行，随后单次12/12通过。未为通过检查而扩容或隐藏限流，429仍按失败报告且不自动重试。

## 官方依据

- [FC计费说明](https://help.aliyun.com/zh/functioncompute/billing-overview-of-fc)
- [FC自定义域名与香港备案要求](https://help.aliyun.com/zh/functioncompute/configure-custom-domain-names)
- [FC自定义HTTP运行时](https://help.aliyun.com/zh/functioncompute/principles-1)
- [FC HTTP触发器限制](https://help.aliyun.com/zh/functioncompute/http-triggers-overview)
- [Supabase自定义域名为付费计划附加项](https://supabase.com/docs/guides/platform/custom-domains)
- [Supabase Auth限流及IP转发要求](https://supabase.com/docs/guides/auth/rate-limits)
