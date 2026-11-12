# 小店利润本：配置注册与找回密码邮件

> 已归档：本文保留早期设计、部署或验收记录，文中状态仅对应记录日期。当前功能和使用方法以 [README](../README.md) 与仓库代码为准；新环境的服务配置、价格和可用性请重新核对。

核对日期：2026-10-17，对应线上版本：v1.2.0。本文记录邮件服务阶段验收结果，并保留新环境配置步骤。

当前进度：`lirunben.cn` 已购买，Resend 发信子域名 `auth.lirunben.cn` 的一条 DKIM TXT 和两条发送 CNAME 已写入并验证；Supabase 自定义 SMTP 已启用。两个用户授权的 Gmail `+` 别名均实际收到注册确认邮件，A 实际收到找回密码邮件；真实确认、密码登录、刷新及密码重置服务链路已通过。两个普通用户 JWT 的 90 项跨商户隔离检查通过。本轮没有修改 Auth 配置。

2026-10-18 正式入口已迁至 [lirunben.cn](https://lirunben.cn)，HTTPS 与新站精确回调已验证保存。原 Sites 的朋友 Safari/4G 阻断工单仍未解决，原站仅作回滚；新站在朋友原网络仍待实测。上述邮件验收完成于 URL 切换前，仅覆盖同一 Gmail 邮箱的两个别名；新站完整邮件回跳和其他邮箱域名仍待验证。

我们使用「自己的域名 → Resend → Supabase 自定义 SMTP」。它负责发送注册确认和密码重置邮件。你不需要自己搭建邮件服务器。

Supabase 默认邮件仅向项目组织的团队成员地址发送，目前限制为每小时 2 封，适合开发验证。正式邀请其他商户前，需要完成下面的配置，并保持邮箱确认开启。[Supabase 官方说明](https://supabase.com/docs/guides/auth/auth-smtp)

## 1. 打开已购域名的 DNS 管理

本项目使用已付款购买的 `lirunben.cn`，注册商后台最新核验状态为“正常”，可以继续发信域名配置，无需重复购买。

正式网站使用 `https://lirunben.cn`，邮件仍使用独立子域名 `auth.lirunben.cn`。原 Sites 域名不属于自己的 DNS 管理范围，不用于发信域名验证。

1. 登录购买 `lirunben.cn` 的域名注册商账号。
2. 确认正在管理的域名为 `lirunben.cn`，避免将记录添加到其他域名。
3. 找到该域名的「DNS 解析」或「管理解析」页面，确认自己有添加记录的权限。暂时不修改已有记录。

发信子域名使用 `auth.lirunben.cn`。子域名是在现有域名下添加的名称，不需要另买一份同名域名。不要在这里填 `https://` 或网页路径。

## 2. 继续验证 Resend 发信域名

Resend 账号已经注册。登录 [Resend](https://resend.com/) 继续配置，按后台提示核对账号验证状态。官方目前提供免费方案：每月 3,000 封、每天最多 100 封，支持 SMTP；免费注册无需信用卡。额度与套餐以后可能变化，以实际后台显示为准。[当前价格](https://resend.com/pricing)、[免费注册说明](https://resend.com/blog/email-automation-for-openclaw-using-resend)

1. 在 Resend 控制台进入 **Domains**，打开已创建的 `auth.lirunben.cn`。
2. 本项目的一条 DKIM TXT 和两条发送 CNAME 已写入并验证；新环境配置时，以该页面实际生成的记录为准。
3. 把每条记录的 **Type、Name、Value、Priority（如有）** 逐项复制到域名的 DNS 解析页面。
4. 回到 Resend 点击验证按钮，等待状态成为 **Verified**，并确认发送功能已验证。DNS 更新可能需要等待，先检查记录再重试。

**DNS 的具体值必须使用你的 Resend 页面实际生成的内容。** 不要复制教程截图里的 DKIM 公钥、TXT 值或 CNAME 目标，也不要由程序猜测。部分解析商自动补全域名，填写后核对最终名称，避免域名重复两次。[Resend 域名验证步骤](https://resend.com/docs/add-a-domain)

本项目只需要发送验证邮件，不需要把现有邮箱的收件服务迁移到 Resend。保留现有根域名的 MX、网站 A/CNAME 和其他业务记录；本次按实际页面添加 DKIM TXT 和两条发送 CNAME。如果新记录与已有记录同名，先核对用途，不覆盖或删除。

同一名称只能有一条 SPF 策略，不能简单叠加两条 `v=spf1` TXT。若已有 SPF 或 DMARC，先按服务商指导合并或核对继承关系，再修改。[邮件认证说明](https://resend.com/blog/email-authentication-a-developers-guide)、[DMARC 初始策略说明](https://resend.com/blog/dmarc-policy-modes)

## 3. 创建专用发送密钥

域名验证成功后，进入 Resend 的 **API Keys → Create API Key**：

- 名称：例如 `xiaodian-profit-supabase`。
- 权限：**Sending access**，如可选则限制到刚验证的发信域名。
- 生成后由你复制密钥，并保存在自己的密码管理器中。[密钥权限说明](https://resend.com/changelog/new-api-key-permissions)

不要把 Resend API Key、账号密码或数据库密码发到聊天、截图或 Git 仓库。下面的 SMTP 密码填 Resend API Key，不是 Resend 登录密码，也不是 Supabase 数据库密码。它只需由你直接填写到 Supabase 后台，不需要放进网站的 `NEXT_PUBLIC_` 配置。

## 4. 把 SMTP 设置填到 Supabase

打开 [小店利润本 Supabase 项目](https://supabase.com/dashboard/project/nporrbvnaezafvryjqao)，进入 **Authentication → Email → SMTP Settings**。后台菜单可能调整；找不到时，在 Authentication 中查找 **Custom SMTP**。启用自定义 SMTP，填写：

| 字段                      | 填写内容                                                  |
| ------------------------- | --------------------------------------------------------- |
| Sender email / 发件人邮箱 | `noreply@example.com`，仅在该发信域名验证成功后使用 |
| Sender name / 发件人名称  | 小店利润本                                                |
| Host / 主机               | `smtp.resend.com`                                         |
| Port / 端口               | `465`                                                     |
| Username / 用户名         | `resend`                                                  |
| Password / 密码           | 第 3 步生成的 Resend API Key，由你直接粘贴                |

保存后检查自定义 SMTP 已启用。上述主机、端口、用户名和密码类型来自 [Resend 的 Supabase SMTP 官方教程](https://resend.com/docs/send-with-supabase-smtp)。发件人地址的域名必须与已验证、且密钥允许发送的域名一致。

在 Resend 该域名的 **Configuration / Configure** 中，将 **Click tracking** 和 **Open tracking** 保持关闭。认证邮件无需跟踪点击或打开；点击跟踪会重写邮件链接。[Resend 跟踪配置说明](https://resend.com/blog/introducing-custom-tracking-domain)

在 Supabase 的 Email 登录提供商设置中，保持 **Confirm email** 开启。不要通过关闭邮箱确认来绕过邮件配置或发送失败。

## 5. 核对邮件返回网站的地址

在 Supabase **Authentication → URL Configuration** 核对以下值。正式网站地址如有变更，要一并更新。

- **Site URL**：`https://lirunben.cn`
- **Redirect URLs**：`https://lirunben.cn/account/`；保留原 Sites 的精确 `/account/` 地址作回滚，不使用生产通配符。
- 本机开发另保留：`http://localhost:3000/account/` 和 `http://127.0.0.1:3000/account/`

本机地址只适合在这台电脑上开发。正式验收要从正式网站提交注册或找回密码，避免邮件返回手机无法访问的本机地址。

启用自定义 SMTP 后，Supabase 当前初始邮件限额为每小时 30 封；它与 Resend 每日、每月额度分别生效。先小范围验收，不连续点击重复发送，按实际需求在 Supabase **Authentication → Rate Limits** 核对限额。[Supabase SMTP 与限额说明](https://supabase.com/docs/guides/auth/auth-smtp)

## 6. 阶段验收与后续检查

2026-10-17 使用用户授权的同一 Gmail 邮箱两个 `+` 别名完成实际服务链路验收，没有把个人地址、JWT 或完整确认链接写入源码文档。

- [x] A、B 的真实 signup 均未返回会话，确认前密码登录返回 `email_not_confirmed`；Gmail 均实际收到非垃圾箱的确认邮件。
- [x] 真实确认请求返回正式网站 `/account/`，Supabase JWT 身份与对应账号一致；密码登录和会话刷新成功。
- [x] A 的找回密码邮件实际送达；重置后旧密码被拒绝、新密码可登录。
- [x] 两个普通用户各自的真实 JWT 完成 90 项隔离检查，客户端使用公开 key，没有使用管理员角色；覆盖双方数据读写拒绝及自有商品、销售、费用与利润计算。
- [x] 测试结束后两个账号全局退出，服务器有效刷新令牌均为零；10 条 QA 经营记录按严格标识清理，五表 QA 残留均为零。QA Auth 账号仍保留，没有删除。
- [ ] 使用其他邮箱域名验收实际投递、退信及额度，不能将两个 Gmail 别名等同于两个独立邮件服务商。
- [ ] 在浏览器人工完成注册、确认、恢复页面及换设备记账全过程；本次 API 真实服务链路验证不能代替这些界面操作。
- [ ] 排查外部 Safari/4G 的 Cloudflare 拒绝访问，核对更多受邀用户的实际可达性。

若报 **Email address not authorized**，检查是否仍在使用 Supabase 默认 SMTP；若提示域名未验证或发送者不允许，检查 Resend 域名状态、发件人地址及密钥权限；若超限，查看两边额度并等待恢复。若链接过期或已使用，重新申请一次新链接，并检查是否开启了邮件链接跟踪或收件方的链接预览。排查时只提供脱敏后的错误信息，不提供邮件完整确认链接或密钥。

当前可以确认本次 Gmail 别名范围内的注册确认与密码重置实际服务链路可用。正式面向更多商户时，还要解决外部可达性阻塞，继续落实多邮箱投递与发送额度监控、防滥用、备份与恢复、隐私及账号注销流程；邮件接通不等于所有商业运营准备已经完成。
