const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFillPrice } = require('../fillPriceResolver');

test('resolveFillPrice uses LTP fallback when broker response has no fill price', async () => {
  const value = await resolveFillPrice({
    orderData: {},
    order: { price: 0 },
    symbol: 'BANKNIFTY26JUL58000CE',
    instrument: { es: 'nse_fo' },
    ltpLookup: async () => 58120,
    tickLookup: async () => 0
  });

  assert.equal(value, 58120);
});

test('resolveFillPrice prefers broker fill price when present', async () => {
  const value = await resolveFillPrice({
    orderData: { fillPrice: 58050 },
    order: { price: 0 },
    symbol: 'BANKNIFTY26JUL58000CE',
    instrument: { es: 'nse_fo' },
    ltpLookup: async () => 58120,
    tickLookup: async () => 0
  });

  assert.equal(value, 58050);
});
