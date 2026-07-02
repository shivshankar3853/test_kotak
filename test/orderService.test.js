const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldPlaceChildOrdersForConfirmation, selectLatestBrokerOrderForPlacement, resolvePriceWithTickFirst, buildChildOrderPayloads, shouldPlaceFreshOrderAfterExit } = require('../orderService');

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

test('buildChildOrderPayloads creates validated TP and SL payloads after execution', () => {
  const payloads = buildChildOrderPayloads({
    instrument: { es: 'nse_fo', ts: 'TEST' },
    action: 'BUY',
    qtyFinal: '100',
    productCode: 'CNC',
    validity: 'DAY',
    fillPrice: 100,
    targetPoints: 10,
    stopLossPoints: 5
  });

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].tag, 'TP');
  assert.equal(payloads[0].jData.pr, '110');
  assert.equal(payloads[0].jData.pt, 'L');
  assert.equal(payloads[0].jData.tp, '0');
  assert.equal(payloads[0].jData.rt, 'DAY');
  assert.equal(payloads[1].tag, 'SL');
  assert.equal(payloads[1].jData.pr, '95');
  assert.equal(payloads[1].jData.pt, 'SL');
  assert.equal(payloads[1].jData.tp, '95');
  assert.equal(payloads[1].jData.rt, 'DAY');
});

test('buildChildOrderPayloads hardcodes TP as limit and SL as stop-loss', () => {
  const payloads = buildChildOrderPayloads({
    instrument: { es: 'nse_fo', ts: 'TEST' },
    action: 'BUY',
    qtyFinal: '100',
    productCode: 'CNC',
    validity: 'DAY',
    fillPrice: 100,
    targetPoints: 10,
    stopLossPoints: 5
  });

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].jData.pt, 'L');
  assert.equal(payloads[1].jData.pt, 'SL');
  assert.equal(payloads[1].jData.tp, '95');
});

test('shouldPlaceFreshOrderAfterExit skips the standalone follow-up placement when reentry is already handled', () => {
  assert.equal(shouldPlaceFreshOrderAfterExit({ currentPosition: null, currentSide: null, incomingSide: 'BUY' }), true);
  assert.equal(shouldPlaceFreshOrderAfterExit({ currentPosition: { side: 'SELL' }, currentSide: 'SELL', incomingSide: 'BUY' }), false);
  assert.equal(shouldPlaceFreshOrderAfterExit({ currentPosition: { side: 'BUY' }, currentSide: 'BUY', incomingSide: 'SELL' }), false);
  assert.equal(shouldPlaceFreshOrderAfterExit({ currentPosition: { side: 'BUY' }, currentSide: 'BUY', incomingSide: 'BUY' }), true);
});

test('exitAndReenter closes the existing opposite position and places a fresh order', async () => {
  const orderService = require('../orderService');
  const Trade = require('../models/Trade');

  const originalPlaceOrder = orderService.placeOrder;

  let callCount = 0;
  orderService.placeOrder = async (order, signalId) => {
    callCount += 1;
    return { nOrdNo: callCount === 2 ? 'new-ord' : 'exit-ord' };
  };

  try {
    const currentPosition = { side: 'SELL', quantity: 2 };
    const newOrder = { TS: 'TEST', quantity: 2, transaction_type: 'BUY', product: 'NRML' };

    const result = await orderService.exitAndReenter(currentPosition, newOrder, 'signal-id');

    assert.equal(callCount, 2);
    assert.equal(result.exitRes.nOrdNo, 'exit-ord');
    assert.equal(result.newRes.nOrdNo, 'new-ord');
  } finally {
    orderService.placeOrder = originalPlaceOrder;
  }
});

test('exitAndReenter closes the existing opposite position and places a fresh order', async () => {
  const orderService = require('../orderService');
  const BrokerOrder = require('../models/BrokerOrder');

  const originalUpdateMany = BrokerOrder.updateMany;
  const originalPlaceOrder = orderService.placeOrder;

  const placeOrderCalls = [];
  BrokerOrder.updateMany = async () => ({ modifiedCount: 1 });
  orderService.placeOrder = async (order, signalId) => {
    placeOrderCalls.push(order);
    return { nOrdNo: placeOrderCalls.length === 2 ? 'new-ord' : 'exit-ord' };
  };

  try {
    const currentPosition = { side: 'SELL', quantity: 2 };
    const newOrder = { TS: 'TEST', quantity: 2, transaction_type: 'BUY', product: 'NRML' };

    const result = await orderService.exitAndReenter(currentPosition, newOrder, 'signal-id');

    assert.equal(placeOrderCalls.length, 2);
    assert.equal(placeOrderCalls[0].transaction_type, 'BUY');
    assert.equal(placeOrderCalls[1].transaction_type, 'BUY');
    assert.equal(result.exitRes.nOrdNo, 'exit-ord');
    assert.equal(result.newRes.nOrdNo, 'new-ord');
  } finally {
    BrokerOrder.updateMany = originalUpdateMany;
    orderService.placeOrder = originalPlaceOrder;
  }
});
