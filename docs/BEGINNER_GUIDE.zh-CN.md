# 编程入门：从小店利润本学起

先把程序当成一个分工明确的小店：页面接待你，计算规则算账，云端保存数据。当前项目是**微信里也能打开的网站，不是微信原生小程序**。

只在本仓库的学习副本中练习，不连接真实账本、不填写真实云端配置、不部署线上。下方算术用“元”帮助理解，**不要拿它替换正式金额算法**。

## 1. 六个名字，各管什么

- **HTML**：网页的骨架，例如标题、输入框、按钮。
- **CSS**：网页的外观，例如文字大小、颜色和间距。项目中的 `className` 给元素指定样式；`text-3xl` 等是 Tailwind CSS 提供的样式简写。
- **JavaScript（JS）**：让页面执行动作的语言，例如点按钮后计算毛利。
- **TypeScript（TS）**：给 JS 加上“数据应该长什么样”的检查。例如 `price: number` 表示售价应是数字；检查不等于保证运行时输入永远正确。
- **React**：把界面拆成可重复使用的小块，并让数据变化反映到页面的工具。这样的界面小块叫“组件”。
- **Next.js**：组织 React 页面、打包网站的框架，也就是替你安排项目结构的一套工具。`.tsx` 文件可以同时写带类型的逻辑和类似 HTML 的界面写法，后者叫 JSX。

**前端**是浏览器里看得见、能点击的部分；**后端**是在远端处理登录、保存和权限的服务；**数据库**是按结构保存商品、销售等数据的地方。**API（应用接口）**就是程序之间按约定请求、返回数据的入口。这个项目把网站导出为静态文件，再调用云端服务，并非每个页面都靠 Next.js 服务器现场生成。

## 2. 用一段小程序学算账

单件毛利＝售价－进价；多件毛利＝（售价－进价）×数量。毛利率＝毛利÷销售额×100%。销售额为零时不能除以零；项目用 `null` 表示此时没有可显示的比率。毛利还没有扣房租等经营费用。

新建独立文件 `profit-demo.mjs`，粘贴以下内容。装好 README 要求的 Node.js（在电脑上运行 JS 的工具）后，在该文件所在文件夹打开 PowerShell，运行 `node .\profit-demo.mjs`：

```js
// 练习专用：金额单位为元，只用虚构数据。
function grossProfit(price, cost, quantity) {
  return (price - cost) * quantity;
}
function margin(profit, revenue) {
  if (revenue === 0) return null;
  return (profit / revenue) * 100;
}
const items = [{ price: 10, cost: 6, quantity: 2 }];
let revenue = 0;
let profit = 0;
for (const item of items) {
  revenue += item.price * item.quantity;
  profit += grossProfit(item.price, item.cost, item.quantity);
}
console.log({ revenue, profit, rate: margin(profit, revenue) });
// 应输出 revenue: 20、profit: 8、rate: 40。
```

**变量**是给数据起名字：`const` 的名字不能重新指向另一份数据；`let` 可以重新赋值。**函数**是取名字的一段步骤：传入参数，用 `return` 返回结果。**if** 是“如果成立，就做这件事”；`===` 用来判断是否相等。

**数组**是有顺序的一组数据，写在 `[]` 里；其中 `{}` 是对象，把一个商品的售价、成本、数量放在一起。`for...of` 逐项处理数组；`+=` 是把新值加到原值上。

## 3. 回到真实源码看对应位置

以下路径都相对于源码根目录：

| 想看什么 | 打开什么 |
| --- | --- |
| 计算、金额校验、日期规则 | `src/lib/domain.ts` |
| 销售页面入口和浏览器标题 | `src/app/sales/page.tsx` |
| 输入框、按钮、搜索和保存动作 | `src/components/sales-screen.tsx` |
| 云端数据读写的封装 | `src/lib/cloud-repository.ts` |
| 开发、检查、测试等命令 | `package.json` |
| 静态导出设置 `output: "export"` | `next.config.ts` |

先读 `domain.ts` 的 `profitRate`，再读 `saleTotals`。正式项目把售价、收入存成整数“分”，把单位成本存成整数“厘”（0.001 元，字段名带 `Mills`）；先按每行数量算成本，再按规则舍入到分，避免小数计算误差。例子中的元与这些整数不能混着相减。

再找销售界面的 `useState`：它保存正在输入的内容等“状态”，更新状态后 React 会更新界面。找 `async function save` 和 `await saveSale(...)`：**异步**是请求发出后等待结果、页面仍可处理其他事情的方式；`await` 等待结果，`try/catch` 接住失败，`finally` 无论成功失败都收尾，例如恢复按钮。

## 4. 三个小练习

1. **改测试标题**：只在学习副本里把 `src/app/sales/page.tsx` 的 `title: "销售记录"` 改为 `title: "销售记录·学习版"`，保存后查看差异。它改的是浏览器标题；页面大标题在 `sales-screen.tsx`。完成后改回。不需要登录或记账。
2. **写纯函数**：只改独立 `profit-demo.mjs`，调用 `grossProfit(12, 7, 3)`，应得到 `15`。纯函数就是同样输入总得到同样输出，且不改外部数据的函数。再试售价低于成本，看看为何得到负数。
3. **加测试**：测试就是让电脑检查“实际结果是否等于预期”。在独立文件开头加入 `import assert from "node:assert/strict";`，结尾加入下面三行，再运行同一条 Node 命令。通过时无额外报错；故意把预期 `8` 改成 `9`，会看到失败，随后改回。

```js
assert.equal(grossProfit(10, 6, 2), 8);
assert.equal(margin(8, 20), 40);
assert.equal(margin(0, 0), null);
```

学会这三件事后，再沿着“输入 → 校验 → 计算 → 显示”读项目。先看懂一条销售怎样算出来，再学保存数据，会更容易。

仓库已附带练习文件。从项目根目录运行：`node examples/profit-demo.mjs`。
