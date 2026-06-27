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
