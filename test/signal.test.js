const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const signal = require('../signal');

test('signal module exposes consolidated trading functions', () => {
  assert.equal(typeof signal.getLTP, 'function');
  assert.equal(typeof signal.getQuote, 'function');
  assert.equal(typeof signal.calculatePnL, 'function');
  assert.equal(typeof signal.monitorTrades, 'function');
  assert.equal(typeof signal.squareOffAll, 'function');
  assert.equal(typeof signal.monitorTargets, 'function');
  assert.equal(typeof signal.monitorTrailingSL, 'function');
  assert.equal(typeof signal.apiLimiter, 'function');
});

test('createQuoteRequestThrottler spaces requests apart', async () => {
  const { createQuoteRequestThrottler } = require('../signal');
  const throttle = createQuoteRequestThrottler(100);
  let calls = 0;

  const start = Date.now();
  await Promise.all([
    throttle(async () => {
      calls += 1;
      return 1;
    }),
    throttle(async () => {
      calls += 1;
      return 2;
    })
  ]);
  const elapsed = Date.now() - start;

  assert.equal(calls, 2);
  assert.ok(elapsed >= 90, `expected throttling delay, got ${elapsed}ms`);
});

test('monitorTargets uses limit exits when target price is hit', async () => {
  const originalGetLTP = signal.getLTP;
  const originalTradeFind = require('../models/Trade').find;
  const originalPlaceOrder = signal.placeOrder;
  const calls = [];

  const Trade = require('../models/Trade');
  Trade.find = async () => [{
    _id: 'trade-1',
    instrument: 'TEST',
    quantity: 1,
    side: 'BUY',
    targetPrice: 110,
    entryPrice: 100,
    status: 'OPEN',
    save: async function () { this.saved = true; return this; }
  }];

  signal.getLTP = async () => 110;
  signal.placeOrder = async (order) => {
    calls.push(order);
    return { status: 'PLACED' };
  };

  try {
    await signal.monitorTargets();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].order_type, 'LIMIT');
    assert.equal(calls[0].price, 110);
    assert.equal(calls[0].transaction_type, 'SELL');
  } finally {
    signal.getLTP = originalGetLTP;
    Trade.find = originalTradeFind;
    signal.placeOrder = originalPlaceOrder;
  }
});

test('webhook enables trailing stop only when TSL is present', async () => {
  const engine = signal.createSignalEngine({ port: 0, quoteFetcher: async () => 100 });
  const port = engine.server.address().port;

  const normalPayload = JSON.stringify({ action: 'BUY', symbol: 'TEST1', qty: 1, target_points: 10, sl_points: 5 });
  const tslPayload = JSON.stringify({ action: 'BUY', symbol: 'TEST2', qty: 1, target_points: 10, sl_points: 5, TSL: 'yes' });

  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/webhook', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(normalPayload) } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(normalPayload);
    req.end();
  });

  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/webhook', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tslPayload) } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(tslPayload);
    req.end();
  });

  assert.equal(engine.positions.TEST1?.useTrailingSL, false);
  assert.equal(engine.positions.TEST2?.useTrailingSL, true);

  engine.stop();
});
