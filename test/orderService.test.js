const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldPlaceChildOrdersForConfirmation, selectLatestBrokerOrderForPlacement, resolvePriceWithTickFirst } = require('../orderService');

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

test('resolvePriceWithTickFirst prefers the websocket tick before falling back to LTP', async () => {
  const price = await resolvePriceWithTickFirst({
    symbol: 'TEST',
    instrument: { es: 'nse_fo' },
    getTickValue: async () => 105,
    getLtpValue: async () => 200
  });

  assert.equal(price, 105);
});
