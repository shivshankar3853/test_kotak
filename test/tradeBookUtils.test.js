const test = require('node:test');
const assert = require('node:assert/strict');

const { extractTradeBookEntries, toFrontendTrade, findTradeBookEntryForTrade } = require('../tradeBookUtils');

test('extractTradeBookEntries parses nested trade-book payloads and avgPrc values', () => {
  const payload = {
    data: {
      tradeBook: [
        {
          sym: 'ITBEES',
          buySell: 'B',
          avgPrc: '35.88',
          qty: 1
        }
      ]
    }
  };

  const entries = extractTradeBookEntries(payload);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].instrument, 'ITBEES');
  assert.equal(entries[0].entryPrice, 35.88);
});

test('toFrontendTrade prefers the trade-book entry price when the local trade price is zero', () => {
  const trade = { instrument: 'ITBEES', quantity: 1, price: 0, entryPrice: 0 };
  const tradeBookEntry = { instrument: 'ITBEES', entryPrice: 35.88 };

  const result = toFrontendTrade(trade, tradeBookEntry);

  assert.equal(result.entryPrice, 35.88);
  assert.equal(result.price, 35.88);
});

test('findTradeBookEntryForTrade picks the matching side and quantity when several rows share the same symbol', () => {
  const trade = { instrument: 'ITBEES', side: 'BUY', quantity: 1 };
  const entries = [
    { instrument: 'ITBEES', side: 'SELL', quantity: 1, entryPrice: 20 },
    { instrument: 'ITBEES', side: 'BUY', quantity: 1, entryPrice: 35.88 }
  ];

  const result = findTradeBookEntryForTrade(trade, entries);

  assert.equal(result.entryPrice, 35.88);
});
