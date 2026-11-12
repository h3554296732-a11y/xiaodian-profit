import Link from "next/link";
export const metadata = { title: "使用与隐私说明" };
export default function PrivacyPage() {
  return (
    <article className="panel mx-auto max-w-3xl space-y-6 text-sm leading-8">
      <h1 className="text-2xl font-semibold">使用与隐私说明</h1>
      <p className="text-stone-500">更新日期：2026年10月19日 · MVP 试用版</p>
      <section>
        <h2 className="font-semibold">账本的计算范围</h2>
        <p>
          系统按你录入的实际销售价格、单位成本、订单其他收入和经营费用计算。未完整录入的税费、人工等成本会影响结果，因此统一展示“估算经营利润”。本工具不提供完整库存计价或税后净利润报表，不能代替法定会计账簿与申报。
        </p>
      </section>
      <section>
        <h2 className="font-semibold">保存的数据</h2>
        <p>
          使用本网站记账需要注册并登录。Supabase
          保存账号邮箱、店铺、商品、销售明细与费用；启用手机号登录时，还会处理你提供的手机号及短信验证码，并通过短信服务商向该号码发出认证短信。密码和验证码由认证服务处理，应用不在经营表中保存明文密码或验证码。数据库以店铺所有权限制商户访问。
        </p>
        <p>
          为改善连接，登录与账本请求经阿里云中国香港节点转发至 Supabase。应用不会在转发节点持久保存请求内容，包括手机号、验证码、密码和登录令牌；账号与账本仍由原认证服务和数据库管理。
        </p>
      </section>
      <section>
        <h2 className="font-semibold">你的选择</h2>
        <p>
          你可以编辑经营记录、停用商品、作废销售及删除费用；这些操作保留历史标记以避免破坏已保存账目。在“店铺与账号”可以导出当前账本。请妥善保管账号，并在公用设备使用后退出登录。
        </p>
      </section>
      <section>
        <h2 className="font-semibold">试用与服务边界</h2>
        <p>
          当前为供店主验证流程的
          MVP。请先用少量数据核对结果，定期导出备份。正式开放商业服务前，运营者还需提供有效的支持联系方式、账号注销及数据删除申请渠道、备份恢复和服务条款；完成这些准备前，不承诺商业服务保障。
        </p>
      </section>
      <p>
        本网站不包含在线支付、广告追踪或 AI
        分析。请勿在备注中录入顾客身份证、支付账号等与经营核算无关的敏感信息。
      </p>
      <Link href="/account" className="button button-primary">
        返回店铺与账号
      </Link>
    </article>
  );
}
