const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldPlaceChildOrdersForConfirmation } = require('../orderService');

test('shouldPlaceChildOrdersForConfirmation waits for completed broker confirmation before placing child orders', () => {
  const brokerOrder = { childOrdersPlaced: false };
  const completedOrder = { orderStatus: 'COMPLETE', entryPrice: 100 };

  assert.equal(shouldPlaceChildOrdersForConfirmation({ brokerOrder, orderStreamData: completedOrder }), true);
  assert.equal(shouldPlaceChildOrdersForConfirmation({ brokerOrder, orderStreamData: { orderStatus: 'OPEN', entryPrice: 100 } }), false);
  assert.equal(shouldPlaceChildOrdersForConfirmation({ brokerOrder: { childOrdersPlaced: true }, orderStreamData: completedOrder }), false);
});
