# 固定 Supabase API 代理（已发布，手机登录及页面刷新通过）

香港阿里云 FC Web 函数使用的独立 Node HTTP 服务。仅使用 Node 内建模块和 `fetch`，不安装依赖，不读取网站 `.env`；本目录不含自动创建云资源的脚本。2026-10-20更新：API域名基础连接及公开权限检查通过，用户三阶段上传的前端59文件全部通过公开HTTPS哈希核验。00:16短信Hook v15的claim超时后，v16已部署；用户确认原故障手机“收到并登录成功”，刷新页面后仍保持登录，商品管理和销售记录页面正常。安全日志已确认OTP、Hook、verify、user及shops成功，详情见下方；令牌到期自动刷新、写入、双账号隔离和邮件回跳仍待独立验收。

固定上游为 `https://nporrbvnaezafvryjqao.supabase.co`，不可由环境变量、Host、请求头、路径或 query 改写。启动入口为 `node server.mjs`，监听 `0.0.0.0:9000`；使用带内建 fetch 的受支持 Node 版本（本地已用 Node 24.19.0 验证）。

## 本地验证

在项目根目录执行：

```powershell
node --test deployment/supabase-proxy/server.test.mjs
```

21 项本地 HTTP/mock 上游测试通过，覆盖 CORS/OPTIONS、固定上游和认证头透传、业务和 Auth 请求、恶意路径/Host/query、服务密钥拒绝、204/HEAD、状态及必要响应头、禁止缓存、写请求和故障不重试、请求/响应上限及超时。测试只连接 `127.0.0.1`，所有 key、令牌、手机号均为本地假数据，不请求 Supabase。

只测试公开健康检查可这样启动：

```powershell
cd deployment/supabase-proxy
$env:PROXY_PUBLIC_HOSTS = 'localhost:9000,127.0.0.1:9000'
node server.mjs
```

打开 `http://localhost:9000/healthz`，应返回：

```json
{"ok":true,"version":"lirunben-supabase-proxy-v1"}
```

`GET/HEAD /healthz` 无需 API key，不探测上游，不发短信。此启动配置下仍不能把其他 API 请求当作本地演示使用：代理上游始终固定为生产 Supabase，只有自动测试注入本地 mock。准备阶段仅运行自动测试或 `/healthz`。

## 已部署 FC 配置与待完成项

用户已批准新增FC按量费用、服务关联角色和数据路径，并另行确认公开HTTP触发器。当前函数为香港 `cn-hongkong` 的 `lirunben-api-proxy`，自定义 Node.js 22 Debian 11运行时，0.10 vCPU、128 MB内存、512 MB临时磁盘，最小实例0、最大弹性实例1、单实例并发5、超时20秒。工作目录放置 `server.mjs`，启动命令为 `node server.mjs`，HTTP端口9000；未接入VPC，公网出网开启，SLS日志和链路追踪关闭。已确认创建 `AliyunServiceRoleForFC`，代理未绑定函数角色、未配置云服务凭据。

HTTP触发器为“无需认证”，允许 `GET, POST, PUT, HEAD, OPTIONS, PATCH`，已移除DELETE；后端用户验证和RLS仍生效。默认测试入口：

`https://lirunbepi-proxy-sanxpofpmv.cn-hongkong.fcapp.run`

此测试入口及 `https://api.lirunben.cn` 的`GET /healthz`均已返回200及固定版本标识；来自 `https://lirunben.cn` 的OTP路径OPTIONS预检已返回204及SDK所需请求头。两入口的无用户令牌`GET /auth/v1/user`均返回401，`GET /rest/v1/shops?select=*&limit=1`均返回401/42501，保持上游权限拒绝，未返回账本数据。原故障手机健康检查、v16收码登录、页面刷新保留会话及商品/销售页面正常，均已由用户确认。

FC自定义域名 `api.lirunben.cn` 路由 `/*` 指向 `lirunben-api-proxy/LATEST`，强制HTTPS，最低TLS1.2并启用TLS1.3，认证为无需认证，CDN关闭。控制台给出的公网CNAME为 `1063692122086253.cn-hongkong.fc.aliyuncs.com`，DNS已保存 `api` CNAME、TTL10分钟、权重1。原生系统解析、正常TLS和健康检查可用；直接向Google/Cloudflare公共DNS查询API CNAME均返回ENODATA，原因未明，尚不能声称两家公共DNS均已核验CNAME。

API独立证书使用已有Let's Encrypt账户和隔离输出目录，ACME TXT验证已通过并完成签发，根域名证书保留。CAS证书名称 `api-lirunben-cn-le-20261019`、资源 `cas-upload-0h0sgc`、ID `27946094-cn-hangzhou`。FC通过CAS选择时拒绝PKCS8 RSA格式，已将同一RSA私钥转换为受限文件 `api.lirunben.cn-rsa.key`（PKCS1），保留原RSA密钥和证书，未重签；FC手动上传名称为 `api-lirunben-cn-rsa-20261019`。正常TLS连接验证通过（authorized=true，协商TLS1.3），证书SHA256指纹为 `93:D5:F3:35:CF:B3:A8:D0:9B:8A:EE:5E:45:BA:3C:B5:89:B9:5A:C2:C8:86:ED:F4:CE:5F:3E:2B:85:6E:A8:CF`，到期 `2027-01-17T12:57:34Z`，当前需手动续期及重新部署。

以FC实际传入的Host配置以下非敏感环境变量：

| 变量 | 说明 |
| --- | --- |
| `PROXY_PUBLIC_HOSTS` | 必填。逗号分隔的精确 FC HTTP 入口/绑定域名 Host，可带端口，不含协议或路径。Host 未在列表内会被拒绝；不信任 `X-Forwarded-Host`。 |
| `PROXY_LOCAL_ORIGINS` | 生产留空。只有本地开发需要时显式填写，例如 `http://localhost:3000`，不同端口不互通；仅允许 HTTP localhost 或 127.0.0.1 加明确端口。 |

当前 `PROXY_PUBLIC_HOSTS` 为 `api.lirunben.cn,lirunbepi-proxy-sanxpofpmv.cn-hongkong.fcapp.run,127.0.0.1:9000,localhost:9000`；未配置额外本地Origin。自定义域名的基础连接检查已通过，原失败手机健康检查已通过，默认触发器域名仅作测试。

默认浏览器 CORS 仅允许 `https://lirunben.cn`，不含 `www`、通配符、`null` 或隐式 localhost，不启用跨域 cookie。无 Origin 的非浏览器客户端仍可访问白名单；CORS 不承担认证、短信频控或数据授权。

网关边界：默认FC测试入口及API自定义域名对不允许的Origin实测均返回403，但仍自动附加该Origin的Allow-Origin和预检字段。应用在上游调用之前拒绝Origin，未暴露私有数据；仍需核对额外FC网关CORS设置（如可配置则关闭）。此处描述的是应用白名单，不能把网关补充的响应头当成应用授权。

不配置任何 Supabase key、数据库密码、`service_role` 或短信凭据。浏览器继续发送原来的 `apikey: sb_publishable_...` 和用户 `Authorization: Bearer ...`，代理原样透传；拒绝 secret key 和带显式管理员角色的 JWT。用户身份、JWT 验证及行权限仍由 Supabase Auth/RLS 检查。代理不提升权限，不返回服务密钥。

FC/域名入口应启用 HTTPS，并关闭 CDN/API 缓存及请求头、正文、query 的日志采集。代理本身只打印固定版本启动信息，不记录请求 URL、手机号、OTP、密码、令牌或上游异常。所有响应强制 `private, no-store`，不转发 Cookie、Set-Cookie、ETag、客户端 Host、转发头及条件缓存头。

代理的FC出口IP会汇集Supabase Auth的IP限流，实际容量以项目配置为准。不要接收任意客户端转发IP头，也不要为了绕过限流在代理中增加secret/service_role key；上线和扩容时应区分429限流与连接失败，并核对[官方限流说明](https://supabase.com/docs/guides/auth/rate-limits)。

已发布构建及本机`.env.local`使用 `NEXT_PUBLIC_SUPABASE_URL=https://api.lirunben.cn` 和 `NEXT_PUBLIC_SUPABASE_STORAGE_KEY=sb-nporrbvnaezafvryjqao-auth-token`，保留原publishable key及旧会话存储键。后续普通构建使用当前API配置，发布前应核对实际产物，避免外部环境覆盖配置后退回直连。当前发布59文件共1,339,034字节，逐文件清单和ZIP已核验，包含API地址、原会话键及香港转发隐私说明；ZIP SHA256为 `34C426A5817E384497A1C15352FD229571BD3E482485186D00A345BC140BBDD7`。

浏览器操作已恢复，此前OSS自动操作的审批拒绝仍有效；本次由用户在控制台完成三阶段手动上传：`artifacts/api-upload-1-assets`的17个静态资源、`api-upload-2-data`的32个TXT/RSC、`api-upload-3-pages`的10个HTML。线上59/59文件公开HTTPS哈希匹配；首页及`/account/`、`/products/`、`/sales/`、`/expenses/`、`/privacy/`均200，新chunk/build资源可见，未知路由404，未实现的`/terms`返回404属预期。默认`out/`的当前59文件已与发布版对齐，旧哈希资源未删，`artifacts/rollback-static-before-api-20261019/`回滚备份仍保留。

2026-10-20 00:16真实OTP请求已到Auth，返回500/`unexpected_failure`；首尔短信Hook v15返回422、执行1896ms，唯一安全诊断为`claim timeout`，未进入供应商。v16将默认claim预算1000ms改为2000ms，仍保留4500ms全局预算、供应商前finish600ms预留、未知状态不发送及无自动重试。62项离线回归通过；v16已部署ACTIVE，`verify_jwt=false`配合函数内签名验证保留，无签名首尔请求401。用户随后确认短信收到、验证码登录成功，刷新页面仍保持登录，商品和销售页正常。尚未单独验证令牌到期后的refresh_token grant、账本写入及跨账号隔离，邮箱确认/找回密码邮件链接也须独立验证。

成功请求安全日志（北京时间2026-10-20）：11:59:25 `POST /auth/v1/otp` 200；11:59:30 首尔Hook v16 200、3533ms；11:59:39 `POST /auth/v1/verify`及`GET /auth/v1/user`均200；11:59:40及12:00:15 `GET /rest/v1/shops`均200。仅核对安全元数据，未读请求体、OTP、JWT或账本内容。商品/销售页加载正常来自用户确认；日志未确认products/sales数据请求或refresh_token grant。

公开检查脚本 `scripts/cloud-public-check.mjs`已支持两个固定地址模式，API模式只顺序执行GET/OPTIONS，每项单次调用、不自动重试。初版12并发曾超过FC单实例5并发而收到429，已修正检测方式，未扩容或隐藏限流。6项离线检查器测试通过；顺序版本单次线上复验12/12通过：5表均401/42501、合法预检204、非法Origin为403/`origin_not_allowed`、无JWT用户请求401、三个禁用路由均404。代理404独立验证路由边界，不能视为数据库42501通过。记录见`artifacts/api-release-state-20261020.json`；公开检查只提供未登录边界证据，手机收码、登录及页面刷新结果另由用户确认，真实跨账号RLS仍待验证。

## 白名单与边界

按当前 `src/lib/cloud-repository.ts`、`ledger-provider.tsx`、Auth 组件和已安装 SDK 的请求形状限定：

| 路径 | 允许方法/参数 |
| --- | --- |
| `/auth/v1/otp`、`verify`、`signup`、`recover`、`resend` | POST JSON。邮件 `redirect_to` 仅可为允许的站点 Origin 下 `/account` 或 `/account/`，不带 query/fragment。 |
| `/auth/v1/token` | POST JSON；`grant_type` 仅 `password` 或 `refresh_token`。 |
| `/auth/v1/user` | GET、HEAD、PUT JSON。 |
| `/auth/v1/logout` | POST；可省略 scope 或仅 `scope=local`。 |
| `/rest/v1/shops`、`products`、`expenses` | GET、HEAD、POST、PATCH。 |
| `/rest/v1/sales`、`sale_items` | GET、HEAD；销售写入只经下列 RPC。 |
| `/rest/v1/rpc/save_sale`、`void_sale` | POST JSON，无 query 参数。 |

表查询只允许当前使用的 select（含 `sales` 的 `*,sale_items(*)`）、UUID 等值/ID 游标过滤、`id.asc`、最多 500 行、商品更新时间过滤及费用 `deleted_at=is.null`；拒绝未知或重复参数、任意表关联、schema 切换及任意 RPC。改动应用查询时需要一并审查白名单。

禁止 admin、OAuth/授权跳转、functions、storage、realtime、任意上游、DELETE、批量 JSON 数组和 URL 编码/路径归一化绕过。允许头列表与 public schema 验证阻止客户端覆盖传输路由。`fetch` 明确设置 `redirect: 'error'` 和 `cache: 'no-store'`，每个请求只调用一次，不自动重试任何方法，也不保存令牌或响应。

JSON 请求最多 256 KiB（含 chunked），缓冲响应最多 8 MiB，上游读取总超时 15 秒，请求/头读取也有超时。保留上游状态、JSON 错误和 Content-Range、Preference-Applied、Retry-After 等必要响应头；对 HEAD、204/205/304 不输出正文，并重算实际正文长度，避免解压/转码后的 Content-Length 不匹配。超时、连接错误及超大上游响应返回固定错误码，不含异常详情。

参考已核对的 [Supabase API key 文档](https://supabase.com/docs/guides/getting-started/api-keys) 和 [TLS 变更公告](https://supabase.com/changelog/cbc-tls-ciphers-deprecated)。该代理不改变上游 TLS 验证规则。
