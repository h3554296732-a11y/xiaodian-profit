"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  ChartColumnIncreasing,
  Coins,
  Info,
  Package,
  Plus,
  ReceiptText,
  Wallet,
} from "lucide-react";
import { useLedger } from "./ledger-provider";
import {
  dateToday,
  dateRange,
  summarize,
  trend,
  rankProducts,
  formatCny,
} from "@/lib/domain";
import { inventoryWarnings } from "@/lib/inventory";

function before(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
export function Dashboard() {
  const { data, shopName } = useLedger();
  const [today, setToday] = useState(() => dateToday());
  useEffect(() => {
    const updateDate = () => setToday(dateToday());
    const timer = window.setInterval(updateDate, 60_000);
    window.addEventListener("focus", updateDate);
    document.addEventListener("visibilitychange", updateDate);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", updateDate);
      document.removeEventListener("visibilitychange", updateDate);
    };
  }, []);
  const [days, setDays] = useState<7 | 30>(7);
  const [ranking, setRanking] = useState<"quantity" | "grossProfit">(
    "quantity",
  );
  const [rankPeriod, setRankPeriod] = useState<"week" | "month">("week");
  const week = dateRange("week", today);
  const month = dateRange("month", today);
  const dayTotal = summarize(data, today, today);
  const weekTotal = summarize(data, week.from, today);
  const monthTotal = summarize(data, month.from, today);
  const inventory = inventoryWarnings(data, today);
  const slowStock = inventory.filter(
    (item) => item.status === "slow" || item.status === "no_sales",
  ).length;
  const emptyStock = inventory.filter(
    (item) => item.status === "out_of_stock",
  ).length;
  const unknownStock = inventory.filter(
    (item) => item.status === "unknown",
  ).length;
  const chart = trend(data, before(today, days - 1), today);
  const rankedRange = dateRange(rankPeriod, today);
  const products = rankProducts(data, rankedRange.from, rankedRange.to)
    .sort((a, b) => b[ranking] - a[ranking] || b.revenue - a.revenue)
    .slice(0, 5);
  const high = Math.max(
    100,
    ...chart.flatMap((row) => [row.revenue, row.profit]),
  );
  const low = Math.min(0, ...chart.map((row) => row.profit));
  const range = Math.max(100, high - low);
  const y = (value: number) => 215 - ((value - low) / range) * 180;
  const x = (index: number) =>
    84 + index * (640 / Math.max(1, chart.length - 1));
  const pointLine = (key: "revenue" | "profit") =>
    chart.map((row, index) => `${x(index)},${y(row[key])}`).join(" ");
  const hasRecords =
    data.sales.some((s) => !s.voidedAt) ||
    data.expenses.some((e) => !e.deletedAt);
  const readableDate = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${today}T04:00:00Z`));
  const metrics = [
    {
      label: "今日营业收入",
      value: dayTotal.revenue,
      caption: `今天 ${dayTotal.saleCount} 笔销售 · ${dayTotal.quantity} 件商品`,
      detail: "包含订单配送费等其他收入",
      icon: Wallet,
      featured: false,
    },
    {
      label: "今日估算经营利润",
      value: dayTotal.profit,
      caption: `估算利润率 ${dayTotal.margin === null ? "—" : `${dayTotal.margin.toFixed(2)}%`}`,
      detail: `已扣经营费用 ${formatCny(dayTotal.expenses)}`,
      icon: Coins,
      featured: true,
    },
    {
      label: "本周估算经营利润",
      value: weekTotal.profit,
      caption: `${week.from.slice(5).replace("-", "月")}日 至今天`,
      detail: "从周一开始，积累每一笔",
      icon: ChartColumnIncreasing,
      featured: false,
    },
    {
      label: "本月估算经营利润",
      value: monthTotal.profit,
      caption: `${today.slice(0, 7).replace("-", "年")}月`,
      detail: `${monthTotal.saleCount} 笔销售 · ${monthTotal.quantity} 件商品`,
      icon: CalendarDays,
      featured: false,
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">每一份努力，都值得看见</p>
          <h1>经营概览</h1>
          <p className="muted">{shopName}，今天的生意怎么样？</p>
        </div>
        <div className="heading-actions">
          <span className="date-label">
            <CalendarDays size={16} />
            {readableDate}
          </span>
          <Link href="/sales" className="button button-primary">
            <Plus size={17} />
            记一笔销售
          </Link>
        </div>
      </div>
      {!data.products.some((p) => !p.deletedAt) && !hasRecords && (
        <div className="welcome-callout">
          <span className="quick-icon mint">
            <Package size={21} />
          </span>
          <div>
            <strong>从第一件商品，开始你的小店账本</strong>
            <p>先记下进价和售价，再录销售与费用，利润就能自动算清楚。</p>
          </div>
          <Link href="/products" className="button button-primary">
            添加商品 <ArrowRight size={15} />
          </Link>
        </div>
      )}
      <section className="metrics" aria-label="关键经营数据">
        {metrics.map(
          ({ label, value, caption, detail, icon: Icon, featured }) => (
            <article
              key={label}
              className={`metric-card ${featured ? "featured" : ""}`}
            >
              <div className="metric-label">
                <span>{label}</span>
                <span className="metric-icon">
                  <Icon size={18} />
                </span>
              </div>
              <strong
                className={`metric-value ${value < 0 && !featured ? "text-red-700" : ""}`}
              >
                {formatCny(value)}
              </strong>
              <p className="metric-detail">{caption}</p>
              <div className="metric-foot">
                <span>{detail}</span>
              </div>
            </article>
          ),
        )}
      </section>
      <Link
        href="/inventory"
        className="my-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-5 py-4"
      >
        <span className="flex min-w-0 items-center gap-3">
          <Package
            size={21}
            className="shrink-0 text-emerald-800"
            aria-hidden="true"
          />
          <span>
            <strong className="block text-sm font-semibold text-stone-900">
              库存与进货
            </strong>
            <span className="mt-1 block text-xs leading-6 text-stone-500">
              {emptyStock} 件缺货 · {slowStock} 件建议暂缓补货 · {unknownStock}{" "}
              件待盘点
            </span>
          </span>
        </span>
        <span className="flex items-center gap-1 text-xs font-medium text-emerald-800">
          查看库存提醒 <ArrowRight size={15} aria-hidden="true" />
        </span>
      </Link>
      <div className="dashboard-grid">
        <section className="panel" aria-labelledby="trend-heading">
          <div className="panel-heading">
            <div>
              <h2 id="trend-heading">生意的变化</h2>
              <p>每日营业收入与估算经营利润</p>
            </div>
            <div className="segmented" aria-label="趋势范围">
              {([7, 30] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={days === value}
                  className={days === value ? "selected" : ""}
                  onClick={() => setDays(value)}
                >
                  近{value}天
                </button>
              ))}
            </div>
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-dot green" />
              营业收入
            </span>
            <span>
              <i className="legend-dot orange" />
              估算经营利润
            </span>
            <small>单位：元</small>
          </div>
          <figure className="chart">
            <svg
              viewBox="0 0 760 270"
              role="img"
              aria-labelledby="real-chart-title real-chart-desc"
            >
              <title id="real-chart-title">{`近${days}天营业收入与估算经营利润`}</title>
              <desc id="real-chart-desc">
                绿色是营业收入，橙色是估算经营利润。无记录日期补零，亏损显示在零轴以下。图后可展开详细数据。
              </desc>
              {[0, 1, 2, 3].map((index) => {
                const value = low + (index / 3) * range;
                return (
                  <g key={index}>
                    <line
                      x1="84"
                      x2="724"
                      y1={y(value)}
                      y2={y(value)}
                      stroke="#e7ece3"
                      strokeDasharray="4 5"
                    />
                    <text x="0" y={y(value) + 5} fontSize="14">
                      {(value / 100).toLocaleString("zh-CN", {
                        maximumFractionDigits: high < 10000 ? 2 : 0,
                        notation: high >= 10000000 ? "compact" : "standard",
                      })}
                    </text>
                  </g>
                );
              })}
              <line x1="84" x2="724" y1={y(0)} y2={y(0)} stroke="#bac8b4" />
              <polyline
                points={pointLine("revenue")}
                fill="none"
                stroke="#28715b"
                strokeWidth="3"
                strokeLinejoin="round"
              />
              <polyline
                points={pointLine("profit")}
                fill="none"
                stroke="#d3924f"
                strokeWidth="3"
                strokeLinejoin="round"
              />
              {chart.map(
                (row, index) =>
                  (index % Math.ceil(days / 5) === 0 ||
                    index === chart.length - 1) && (
                    <g key={row.date}>
                      <circle
                        cx={x(index)}
                        cy={y(row.revenue)}
                        r="3.5"
                        fill="white"
                        stroke="#28715b"
                        strokeWidth="2"
                      />
                      <circle
                        cx={x(index)}
                        cy={y(row.profit)}
                        r="3"
                        fill="white"
                        stroke="#d3924f"
                        strokeWidth="2"
                      />
                      <text
                        x={x(index)}
                        y="251"
                        textAnchor="middle"
                        fontSize="14"
                      >
                        {row.date.slice(5).replace("-", "/")}
                      </text>
                    </g>
                  ),
              )}
            </svg>
            <figcaption className="text-xs leading-6 text-stone-500">
              {hasRecords
                ? "只统计有效销售与已记录费用；补录会计入所选经营日期。"
                : "还没有经营记录，记录第一笔销售后，这里就会出现趋势。"}
            </figcaption>
          </figure>
          <details className="chart-data mt-4">
            <summary>查看趋势数据表</summary>
            <div className="table-scroll">
              <table>
                <caption className="sr-only">每日收入和估算经营利润</caption>
                <thead>
                  <tr>
                    <th scope="col">日期</th>
                    <th scope="col">营业收入</th>
                    <th scope="col">估算经营利润</th>
                  </tr>
                </thead>
                <tbody>
                  {chart.map((row) => (
                    <tr key={row.date}>
                      <th scope="row">{row.date}</th>
                      <td>{formatCny(row.revenue)}</td>
                      <td>{formatCny(row.profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
        <section className="panel" aria-labelledby="breakdown-heading">
          <div className="panel-heading">
            <div>
              <h2 id="breakdown-heading">今天的钱去哪了</h2>
              <p>从营业收入到估算经营利润</p>
            </div>
          </div>
          <div className="income-total">
            <span>营业收入</span>
            <strong>{formatCny(dayTotal.revenue)}</strong>
          </div>
          <dl className="today-breakdown">
            <div>
              <dt>商品销售成本</dt>
              <dd>− {formatCny(dayTotal.cost)}</dd>
            </div>
            <div>
              <dt>毛利润</dt>
              <dd>{formatCny(dayTotal.grossProfit)}</dd>
            </div>
            <div>
              <dt>已记录经营费用</dt>
              <dd>− {formatCny(dayTotal.expenses)}</dd>
            </div>
            <div className="strong-total">
              <dt>估算经营利润</dt>
              <dd className={dayTotal.profit < 0 ? "text-red-700" : ""}>
                {formatCny(dayTotal.profit)}
              </dd>
            </div>
          </dl>
          <div className="explain-note">
            <Info size={16} />
            <p>
              只扣除已售商品的成本。进货时未售出的商品，不会全部算成当天成本。
            </p>
          </div>
        </section>
      </div>
      <div className="dashboard-grid bottom-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>店里的好生意</h2>
              <p>商品销量与毛利贡献排行榜</p>
            </div>
            <select
              aria-label="排行榜期间"
              value={rankPeriod}
              onChange={(e) =>
                setRankPeriod(e.target.value as "week" | "month")
              }
              className="min-h-11 rounded-lg border border-stone-200 bg-white p-2 text-xs text-stone-600"
            >
              <option value="week">本周</option>
              <option value="month">本月</option>
            </select>
          </div>
          <div className="ranking-tabs" aria-label="商品排行类型">
            <button
              type="button"
              aria-pressed={ranking === "quantity"}
              onClick={() => setRanking("quantity")}
              className={ranking === "quantity" ? "active" : ""}
            >
              销量排行
            </button>
            <button
              type="button"
              aria-pressed={ranking === "grossProfit"}
              onClick={() => setRanking("grossProfit")}
              className={ranking === "grossProfit" ? "active" : ""}
            >
              商品毛利贡献
            </button>
          </div>
          {products.length ? (
            <ol className="product-ranking">
              {products.map((product, index) => (
                <li key={product.productId}>
                  <span className={index === 0 ? "rank first" : "rank"}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={`product-thumb ${["mint", "peach", "blue", "lilac"][index % 4]}`}
                  >
                    {product.name.slice(0, 1)}
                  </span>
                  <div className="product-info">
                    <strong>{product.name}</strong>
                    <span>{product.category || "未分类"}</span>
                  </div>
                  <div className="product-rank-value">
                    <strong
                      className={
                        product.grossProfit < 0 && ranking === "grossProfit"
                          ? "text-red-700"
                          : ""
                      }
                    >
                      {ranking === "quantity"
                        ? `${product.quantity} 件`
                        : formatCny(product.grossProfit)}
                    </strong>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-12 text-center text-sm text-stone-500">
              这段时间还没有有效销售，记一笔试试。
            </p>
          )}
          <p className="ranking-note">
            商品贡献仅含商品销售收入减商品成本，不分摊配送费与经营费用。
          </p>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>把每天的生意记下来</h2>
              <p>商品建好后，每天只需记销售与开支</p>
            </div>
          </div>
          {[
            {
              href: "/products",
              title: "商品资料",
              description: "维护进货价和售价，历史记录保留快照",
              icon: Package,
              color: "mint",
            },
            {
              href: "/sales",
              title: "记录销售",
              description: "选择商品、填写数量，确认本次售价",
              icon: ReceiptText,
              color: "peach",
            },
            {
              href: "/expenses",
              title: "记录费用",
              description: "运输、包装、损耗、房租，都别漏掉",
              icon: Wallet,
              color: "blue",
            },
          ].map(({ href, title, description, icon: Icon, color }) => (
            <Link key={href} href={href} className="quick-link">
              <span className={`quick-icon ${color}`}>
                <Icon size={19} />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
              <ArrowRight size={16} />
            </Link>
          ))}
          <div className="gentle-tip">
            <span>一点小提醒</span>
            <p>月租一次录入会集中影响当日利润，可结合本月利润一起看。</p>
          </div>
        </section>
      </div>
      <p className="profit-disclaimer">
        <Info size={15} />
        <span>
          这里只扣除已记录的成本和费用。未录入的税费、人工等会影响结果，估算经营利润不代表税后净利润。
          <Link href="/guide#profit-rules">查看计算口径</Link>
        </span>
      </p>
    </>
  );
}
