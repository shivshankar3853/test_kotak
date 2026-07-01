function resolveTradeEntryPrice(trade = {}) {
  const candidates = [
    Number(trade?.entryPrice),
    Number(trade?.price),
    Number(trade?.avgPrice),
    Number(trade?.averagePrice),
    Number(trade?.fillPrice)
  ];

  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }

  return 0;
}

function normalizeTradeEntryPrice(trade = {}) {
  const entryPrice = resolveTradeEntryPrice(trade);
  return {
    ...trade,
    entryPrice,
    price: entryPrice
  };
}

module.exports = {
  resolveTradeEntryPrice,
  normalizeTradeEntryPrice
};
