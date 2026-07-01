async function resolveFillPrice({
  orderData = {},
  order = {},
  symbol,
  instrument,
  ltpLookup,
  tickLookup
} = {}) {
  const candidates = [
    orderData?.fillPrice,
    orderData?.avgPrice,
    orderData?.price,
    orderData?.lastPrice,
    order?.fillPrice,
    order?.avgPrice,
    order?.price,
    order?.limit_price,
    order?.trigger_price,
    order?.triggerPrice,
    order?.PRICE,
    order?.PRICE
  ];

  for (const candidate of candidates) {
    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return numericValue;
    }
  }

  if (!symbol) {
    return 0;
  }

  if (typeof ltpLookup === "function") {
    try {
      const ltpValue = Number(await ltpLookup(symbol, instrument?.es));
      if (Number.isFinite(ltpValue) && ltpValue > 0) {
        return ltpValue;
      }
    } catch (_) {
      // ignore and continue to tick fallback
    }
  }

  if (typeof tickLookup === "function") {
    try {
      const tickValue = Number(await tickLookup(symbol));
      if (Number.isFinite(tickValue) && tickValue > 0) {
        return tickValue;
      }
    } catch (_) {
      // ignore
    }
  }

  return 0;
}

module.exports = {
  resolveFillPrice
};
