import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  Database,
  Package,
  Receipt,
  ShoppingBag,
} from "lucide-react";

export const metadata = { title: "使用说明" };

const steps = [
  {
    icon: Package,
    title: "先添加商品",
    text: "在商品管理中填写名称、类别、进货单价和销售单价，单件毛利与毛利率会自动算好。价格变动时可以编辑；不再销售的商品可以停用，以后也能恢复。停用不会删除过去的销售。",
    href: "/products",
    action: "管理商品",
  },
  {
    icon: ShoppingBag,
    title: "每天记下销售",
    text: "选择商品、填写销售数量，一笔销售可以包含多种商品。折扣或促销时，直接修改实际成交单价；成本也按这次销售的实际情况填写。每笔销售保留当时的名称、售价和单位成本，以后修改商品资料不会改变旧账。",
    href: "/sales",
    action: "记录销售",
  },
  {
    icon: Receipt,
    title: "顺手记下经营费用",
    text: "运输、包装、商品损耗、水电、租金等开支，在经营费用中按发生日期记录。发现填错后可以编辑或删除。进货单价已在销售时参与成本计算，请不要再把整批进货款重复记成费用。",
    href: "/expenses",
    action: "记录费用",
  },
];

export default function GuidePage() {
  return (
    <div className="space-y-6">
      <div className="page-heading">
        <div>
          <p className="eyebrow">GETTING STARTED · 使用说明</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            从一笔清楚的小账开始
          </h1>
          <p className="muted mt-3 max-w-xl">
            先记商品，再记销售和开支，就能看到店铺的估算经营利润。
          </p>
        </div>
      </div>

      <section
        className="grid gap-4 lg:grid-cols-3"
        aria-label="开始记账的三个步骤"
      >
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <article key={step.title} className="panel flex flex-col">
              <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800">
                <Icon size={22} aria-hidden="true" />
              </span>
              <h2 className="text-base font-semibold text-stone-900">
                {index + 1}. {step.title}
              </h2>
              <p className="mt-3 flex-1 text-sm leading-7 text-stone-600">
                {step.text}
              </p>
              <Link
                href={step.href}
                className="mt-4 inline-flex min-h-11 items-center gap-2 self-start text-sm font-medium text-emerald-800"
              >
                {step.action}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </article>
          );
        })}
      </section>

      <section className="panel" aria-labelledby="inventory-guide">
        <h2
          id="inventory-guide"
          className="text-base font-semibold text-stone-900"
        >
          库存和进货，怎样开始？
        </h2>
        <p className="mt-3 text-sm leading-7 text-stone-600">
          先在“库存与进货”数清实际剩余数量，逐件商品做首次盘点；没盘点的商品显示“待录入”，不会当成零库存。此后新进货增加库存，新销售自动扣减，修改或作废销售会同步调整余量。数量不准时可再次盘点，以实际存货重新校正。
        </p>
        <p className="mt-3 text-sm leading-7 text-stone-600">
          盘点前已发生的销售包含在实际剩余数中，补录旧小票不会再扣一次。套餐独立记库存，不自动拆扣单品。进货单价只保存在该笔进货里，不会改动商品常用进价或旧销售利润；请勿把整批采购款重复计入经营费用。
        </p>
        <p className="mt-3 text-sm leading-7 text-stone-600">
          系统用含今天的最近7天已记销量估算还能卖多久，默认超过30天提醒暂缓补货，天数可在库存页调整；漏记销售会影响判断，近7天没有销量时单独提醒。
        </p>
        <Link
          href="/inventory"
          className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-800"
        >
          打开库存与进货 <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </section>

      <section className="panel" aria-labelledby="wechat-import-guide">
        <h2
          id="wechat-import-guide"
          className="text-base font-semibold text-stone-900"
        >
          微信经营收款，怎么导入？
        </h2>
        <p className="mt-3 text-sm leading-7 text-stone-600">
          在微信「经营收款 → 下单助手 →
          小票单」右上角菜单中选择「导出小票单」。回到利润本的「销售记录」，点击「导入微信小票」，选择原始
          Excel，核对商品、进货成本和收款状态后保存。额外收取的费用会保留为额外收入。
        </p>
        <p className="mt-3 text-sm leading-7 text-stone-600">
          已有小票会跳过；有退款、优惠或异常提示的小票请先核对。文件没有交易单号，相同内容的不同交易仍需人工确认。当前通过导出文件导入，不会自动同步微信订单。
        </p>
        <Link
          href="/sales"
          className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-800"
        >
          打开销售记录 <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </section>

      <section
        id="profit-rules"
        className="panel scroll-mt-6"
        aria-labelledby="profit-rules-title"
      >
        <h2
          id="profit-rules-title"
          className="flex items-center gap-2 text-base font-semibold text-stone-900"
        >
          <BookOpen size={20} className="text-emerald-800" aria-hidden="true" />
          利润是怎么算的？
        </h2>
        <dl className="mt-5 space-y-4 text-sm leading-7">
          <div>
            <dt className="font-medium text-stone-900">营业收入</dt>
            <dd className="mt-1 text-stone-600">
              商品实际销售收入 +
              配送费等其他营业收入。向顾客收取的配送费，每笔销售只填一次；支付出去的配送费记入经营费用。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-900">商品销售成本</dt>
            <dd className="mt-1 text-stone-600">
              每项已售商品的数量 ×
              这笔销售保存的单位成本。单位成本最多三位小数，每条明细算完后四舍五入到分，再加总。尚未售出的商品不会直接计入销售成本。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-900">毛利润</dt>
            <dd className="mt-1 text-stone-600">
              营业收入 −
              商品销售成本。商品排行中的毛利贡献只计算商品本身，不分摊整笔销售的配送收入和经营费用。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-stone-900">估算经营利润与利润率</dt>
            <dd className="mt-1 text-stone-600">
              估算经营利润 = 毛利润 − 已记录经营费用。估算利润率 = 估算经营利润
              ÷ 营业收入 × 100%；营业收入为 0 时，利润率显示「—」。
            </dd>
          </div>
        </dl>
        <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm leading-7 text-amber-900">
          如果没有完整记录税费、人工或其他必要成本，这些数字只能作为估算经营利润，不能当作完整的税后净利润。
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel" aria-labelledby="dates-title">
          <h2
            id="dates-title"
            className="flex items-center gap-2 text-base font-semibold text-stone-900"
          >
            <CalendarDays
              size={20}
              className="text-emerald-800"
              aria-hidden="true"
            />
            补记旧账，归到哪一天？
          </h2>
          <p className="mt-3 text-sm leading-7 text-stone-600">
            看板按销售和费用填写的「经营日期」统计，日期以中国标准时间（上海时区，UTC+8）为准。本周从周一开始，本月从每月
            1 日开始，均统计到今天。
          </p>
          <p className="mt-3 text-sm leading-7 text-stone-600">
            补记过去的销售或费用后，金额会归到所选经营日期。修改历史销售会重新计算对应日期的利润；作废销售仍保留明细，但不再参与统计。
          </p>
        </section>
        <section className="panel" aria-labelledby="storage-title">
          <h2
            id="storage-title"
            className="flex items-center gap-2 text-base font-semibold text-stone-900"
          >
            <Database
              size={20}
              className="text-emerald-800"
              aria-hidden="true"
            />
            账号与账本备份
          </h2>
          <p className="mt-3 text-sm leading-7 text-stone-600">
            注册并登录后才能记账。商品、销售和经营费用保存在当前账号自己的云端店铺中，其他商户无法查看或修改。
          </p>
          <p className="mt-3 text-sm leading-7 text-stone-600">
            换设备时登录同一账号即可继续使用。请在「店铺与账号」页定期导出账本备份，并在公用设备使用后退出登录。
          </p>
          <Link
            href="/account"
            className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-800"
          >
            打开账号与数据
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </section>
      </div>

      <section
        id="roadmap"
        className="panel scroll-mt-6"
        aria-labelledby="scope-title"
      >
        <h2 id="scope-title" className="text-base font-semibold text-stone-900">
          这一版适合怎么用？
        </h2>
        <p className="mt-3 text-sm leading-7 text-stone-600">
          适合一家小店按人民币记录日常零售收入和经营开支。销售数量按「件」填写正整数，称重或小数数量暂不支持。
        </p>
        <p className="mt-3 text-sm leading-7 text-stone-600">
          这一版不管理剩余库存，也暂不支持退货、赊账和应收款核算。请按已完成的实际销售记账，录入后核对日期、数量、实际售价和成本。
        </p>
      </section>
    </div>
  );
}
