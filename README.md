# 小店利润本

面向小卖部、便利店和小型零售店的经营账本，帮助记录销售、成本、费用和库存，了解店铺实际经营情况。适合手机使用，也能在微信浏览器中打开。

本项目是 **Next.js 网站**，不是微信原生小程序。微信收款助手的小票通过导出的 Excel 文件导入；不包含微信收款平台的实时订单接口。

## 功能

- 商品管理：进价、售价、分类、停用与恢复。
- 销售记录：多商品订单、其他收入、历史更正、作废、毛利和毛利率。
- 微信小票 Excel 导入：预览、商品匹配、补充真实成本、重复检查、仅补记销售选项。
- 费用与经营概览：收入、毛利、费用和估算利润，近 7 / 30 天趋势。
- 库存：盘点、进货、销售扣库存、按近期销量估算周转天数。
- 云端账号：邮箱及可选短信登录、店铺数据隔离、找回密码与会话恢复。

售价、收入、费用使用整数“分”；单位成本使用整数“厘”（0.001 元），避免直接用浮点小数记账。毛利没有扣除房租等经营费用。

## 先运行起来

已验证环境：Node.js 24.22.1、pnpm 11.25.0。源码要求 Node.js 22 或以上，使用项目锁定的 pnpm 版本。

1. 安装 [Node.js](https://nodejs.org/en/download) 和 [pnpm](https://pnpm.io/installation)。
2. 下载本仓库，进入项目根目录，在终端运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

3. 打开终端显示的地址，通常是 [http://127.0.0.1:3000](http://127.0.0.1:3000)。保持终端运行；Ctrl+C 停止服务。

**没有云端配置时可以运行页面、学习和构建，但不能登录或读写账本。** 本仓库不提供公共测试账号或演示数据库。

## 连接自己的云端

复制 `.env.example` 为 `.env.local`，填写自己项目的 URL 和公开 publishable key。`NEXT_PUBLIC_` 开头的变量会进入浏览器代码，不能填写管理员密钥、数据库密码或短信密钥。

数据库结构在 [supabase/schema.sql](supabase/schema.sql)，增量变更在 [supabase/migrations](supabase/migrations)。新环境先核对完整结构，已有环境按迁移记录增量更新；不要把完整建表脚本反复运行在已有账本上。

需要另行配置自己的 Supabase Auth、邮件发送、允许回调地址和数据权限。短信功能默认关闭；接入自己的短信服务及签名验证后再启用。参考 [邮件配置](docs/EMAIL_SETUP.md) 和 [短信配置](docs/PHONE_AUTH_SETUP.md)。这些阶段文档保留项目历史，当前代码与本 README 优先。

[香港 API 代理](deployment/supabase-proxy/README.md) 是可选部署组件。代理与诊断/证书脚本保留原项目域名和接口白名单，部署到自己的项目时必须逐项修改并测试，不能直接借用原站服务。不要将代理改成可转发任意网址的公开入口。

## 开发与检查

```powershell
pnpm test
pnpm typecheck
node --test deployment/supabase-proxy/server.test.mjs
pnpm build
pnpm start
```

`pnpm build` 静态导出到 `out/`；`pnpm start` 使用项目脚本预览导出目录，不是 `next start`。部署时将 `out/` 内容放到支持目录首页和 HTTPS 的静态托管，并配置自己的域名、回调和环境变量；前端公开环境变量需要在构建前设置。

短信 Hook 的离线测试需要单独安装 QA 依赖：

```powershell
pnpm --dir supabase/functions/send-auth-sms/qa install --frozen-lockfile --ignore-scripts --ignore-workspace
pnpm test:auth-sms
```

源代码交付副本已通过 150 项业务单元测试、23 项代理测试、62 项短信模拟测试、类型检查和生产构建。这些检查不代表新部署的短信、数据库权限和真实手机网络已经验收。连接真实服务的运维脚本请先阅读内容，不属于新手启动步骤。

## 从代码学习

- [中文编程入门](docs/BEGINNER_GUIDE.zh-CN.md)：变量、函数、条件、数组、组件和异步请求。
- [独立算账练习](examples/profit-demo.mjs)：运行 `node examples/profit-demo.mjs`，不用登录云端。
- [已知问题与版本范围](docs/KNOWN_ISSUES.md)。

```text
src/app/              页面入口
src/components/       界面与操作
src/lib/              算账、导入、库存、登录和数据读写
supabase/             数据库结构、迁移与短信函数
deployment/           可选香港 API 代理
scripts/              检查与运维工具
docs/                 中文教程和技术文档
examples/             独立学习示例
```

## 版本范围

首次公开源码整理于 2026-11-12，以已交付源码为基础。小票导入采用已发布的源文件快照；本地尚未发布的另一个补丁未合并。公开仓库没有携带原私有 Git 历史、真实账本、顾客小票、云端密钥、证书私钥、依赖或构建产物。

微信隔一段时间要求重新登录的问题仍在跟踪；已修复部分刷新请求被限流后误清会话的情况，不能承诺永久免登录。详见已知问题文档。

## 许可证

[MIT License](LICENSE)。可以使用、修改和分发，保留版权与许可声明；第三方依赖仍遵循各自许可证。
