// 编程入门练习：金额单位为元，使用虚构数据，不连接真实账本。
import assert from 'node:assert/strict';

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
assert.equal(grossProfit(10, 6, 2), 8);
assert.equal(grossProfit(12, 7, 3), 15);
assert.equal(grossProfit(3, 5, 1), -2);
assert.equal(margin(8, 20), 40);
assert.equal(margin(0, 0), null);
console.log('练习检查通过');
