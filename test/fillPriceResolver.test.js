const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFillPrice, resolveBrokerEntryPrice, isBrokerOrderComplete } = require('../fillPriceResolver');

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

test('resolveFillPrice retries until a delayed quote arrives', async () => {
  let attempts = 0;
  const value = await resolveFillPrice({
    orderData: {},
    order: { price: 0 },
    symbol: 'BANKNIFTY26JUL58000CE',
    instrument: { es: 'nse_fo' },
    ltpLookup: async () => {
      attempts += 1;
      return attempts >= 2 ? 58130 : 0;
    },
    tickLookup: async () => 0,
    maxAttempts: 3,
    delayMs: 1
  });

  assert.equal(value, 58130);
  assert.equal(attempts, 2);
});

test('resolveBrokerEntryPrice reads the price from the broker order-details response', async () => {
  const value = await resolveBrokerEntryPrice({
    orderId: '260701000581912',
    sessionToken: 'token',
    sid: 'sid',
    baseUrl: 'https://example.test',
    axiosInstance: {
      post: async () => ({
        data: {
          data: {
            avgPrice: 58090,
            nOrdNo: '260701000581912'
          }
        }
      })
    }
  });

  assert.equal(value, 58090);
});

test('isBrokerOrderComplete handles nested array order payloads', () => {
  const value = isBrokerOrderComplete({
    data: [
      {
        status: 'COMPLETE',
        avgPrice: 99345.5
      }
    ]
  });

  assert.equal(value, true);
});
