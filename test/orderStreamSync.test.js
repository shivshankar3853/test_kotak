const test = require('node:test');
const assert = require('node:assert/strict');

const { extractOrderStreamData, normalizeOrderStatus } = require('../orderStreamSync');

test('extractOrderStreamData reads entry price and completed status from the websocket order payload', () => {
  const payload = {
    type: 'order',
    data: {
      nOrdNo: '260216000308219',
      ordSt: 'complete',
      avgPrc: '35.88',
      sym: 'ITBEES',
      trnsTp: 'B'
    }
  };

  const result = extractOrderStreamData(payload);

  assert.equal(result.orderId, '260216000308219');
  assert.equal(result.orderStatus, 'COMPLETE');
  assert.equal(result.entryPrice, 35.88);
  assert.equal(result.symbol, 'ITBEES');
});

test('normalizeOrderStatus maps websocket states to readable values', () => {
  assert.equal(normalizeOrderStatus('complete'), 'COMPLETE');
  assert.equal(normalizeOrderStatus('open pending'), 'OPEN');
  assert.equal(normalizeOrderStatus('rejected'), 'REJECTED');
});
