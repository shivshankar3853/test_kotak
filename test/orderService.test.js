const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldPlaceChildOrdersForConfirmation, selectLatestBrokerOrderForPlacement } = require('../orderService');

test('shouldPlaceChildOrdersForConfirmation waits for completed broker confirmation before placing child orders', () => {
  const brokerOrder = { childOrdersPlaced: false, brokerOrderId: '260701000630614' };
  const completedOrder = { orderId: '260701000630614', orderStatus: 'COMPLETE', entryPrice: 100 };

  assert.equal(shouldPlaceChildOrdersForConfirmation({ brokerOrder, orderStreamData: completedOrder }), true);
  assert.equal(shouldPlaceChildOrdersForConfirmation({ brokerOrder, orderStreamData: { orderStatus: 'OPEN', entryPrice: 100 } }), true);
  assert.equal(shouldPlaceChildOrdersForConfirmation({ brokerOrder: { childOrdersPlaced: true, brokerOrderId: '260701000630614' }, orderStreamData: completedOrder }), false);
  assert.equal(shouldPlaceChildOrdersForConfirmation({ brokerOrder: { childOrdersPlaced: false, brokerOrderId: '260701000630614' }, orderStreamData: { orderId: '260701000630614' }, resolvedEntryPrice: 100 }), true);
});

test('selectLatestBrokerOrderForPlacement prefers the newest matching broker order', () => {
  const currentOrder = { _id: 'old', symbol: 'TEST' };
  const latestOrder = { _id: 'new', symbol: 'TEST' };

  const result = selectLatestBrokerOrderForPlacement({ currentBrokerOrder: currentOrder, targetSymbol: 'TEST', latestBrokerOrder: latestOrder });

  assert.equal(result._id, 'new');
});
