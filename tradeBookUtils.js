function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeTradeBookEntry(entry = {}) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const instrument = raw.instrument || raw.trdSym || raw.tsym || raw.symbol || raw.sym || raw.scrip || raw.security || raw.tradeSymbol || raw.trading_symbol || raw.ticker || raw.sec || "";
  const side = raw.side || raw.buySell || raw.buy_sell || raw.transactionType || raw.trnType || raw.tt || raw.action || "";
  const quantity = Number(raw.quantity || raw.qty || raw.qtty || raw.tradeQty || raw.trdQty || raw.lotQty || raw.quantityTraded || raw.filledQty || raw.fldQty || 0);
  const entryPrice = Number(
    raw.entryPrice ||
    raw.avgPrice ||
    raw.avgPrc ||
    raw.averagePrice ||
    raw.price ||
    raw.tradePrice ||
    raw.fillPrice ||
    raw.avgprice ||
    raw.avg_prc ||
    raw.average_price ||
    raw.avg_prc ||
    0
  );
  const orderId = raw.orderId || raw.nOrdNo || raw.ordNo || raw.orderNo || raw.order_id || raw.orderid || raw.order_no || null;
  const time = raw.time || raw.tradeTime || raw.tradeDate || raw.orderDate || raw.createdAt || raw.updatedAt || null;

  return {
    instrument,
    side,
    quantity,
    entryPrice,
    orderId,
    time,
    raw
  };
}

function extractTradeBookEntries(payload = {}) {
  const entries = [];

  const pushArray = (value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item && typeof item === "object") {
          entries.push(item);
        }
      });
    }
  };

  const pushNested = (value) => {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      pushArray(value);
      return;
    }

    pushArray(value?.tradeBook);
    pushArray(value?.trades);
    pushArray(value?.entries);
    pushArray(value?.result);
    pushArray(value?.payload);
    pushArray(value?.data);

    if (value?.data && typeof value.data === "object") {
      pushArray(value.data?.tradeBook);
      pushArray(value.data?.trades);
      pushArray(value.data?.entries);
      pushArray(value.data?.result);
      pushArray(value.data?.payload);
      pushArray(value.data?.data);
    }
  };

  pushNested(payload);
  pushNested(payload?.data);
  pushNested(payload?.data?.data);

  const normalizedEntries = entries
    .map(normalizeTradeBookEntry)
    .filter((entry) => entry.instrument || entry.orderId || entry.entryPrice > 0);

  const seen = new Set();
  return normalizedEntries.filter((entry) => {
    const key = [entry.orderId || "", entry.instrument || "", entry.side || "", entry.entryPrice || ""].join("::");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findTradeBookEntryForTrade(trade = {}, tradeBookEntries = []) {
  const tradeOrderId = String(trade?.orderId || trade?.brokerOrderId || "").trim();
  const tradeInstrument = normalizeSymbol(trade?.instrument || trade?.symbol || trade?.ts || "");
  const tradeSide = String(trade?.side || trade?.transactionType || trade?.action || "").trim().toUpperCase();
  const tradeQuantity = Number(trade?.quantity || trade?.qty || 0);

  for (const entry of tradeBookEntries) {
    const entryOrderId = String(entry?.orderId || entry?.raw?.orderId || entry?.raw?.nOrdNo || "").trim();
    const entryInstrument = normalizeSymbol(entry?.instrument || entry?.raw?.trdSym || entry?.raw?.symbol || "");
    const entrySide = String(entry?.side || entry?.raw?.buySell || entry?.raw?.side || entry?.raw?.transactionType || entry?.raw?.action || "").trim().toUpperCase();
    const entryQuantity = Number(entry?.quantity || entry?.raw?.qty || entry?.raw?.quantity || entry?.raw?.tradeQty || 0);

    if (tradeOrderId && entryOrderId && tradeOrderId === entryOrderId) {
      return entry;
    }

    if (tradeInstrument && entryInstrument && tradeInstrument === entryInstrument) {
      const sameSide = !tradeSide || !entrySide || tradeSide === entrySide;
      const sameQuantity = !tradeQuantity || !entryQuantity || tradeQuantity === entryQuantity;

      if (sameSide && sameQuantity) {
        return entry;
      }
    }
  }

  return null;
}

function toFrontendTrade(trade = {}, tradeBookEntry = null) {
  const normalizedTrade = trade && typeof trade === "object" ? trade : {};
  const entryPrice = Number(
    normalizedTrade.entryPrice ||
    normalizedTrade.price ||
    tradeBookEntry?.entryPrice ||
    tradeBookEntry?.raw?.avgPrc ||
    tradeBookEntry?.raw?.avgPrice ||
    0
  );

  return {
    ...normalizedTrade,
    entryPrice,
    price: entryPrice > 0 ? entryPrice : normalizedTrade.price || 0,
    side: normalizedTrade.side || tradeBookEntry?.side || "",
    quantity: normalizedTrade.quantity || tradeBookEntry?.quantity || 0,
    instrument: normalizedTrade.instrument || tradeBookEntry?.instrument || "",
    time: normalizedTrade.time || tradeBookEntry?.time || null
  };
}

module.exports = {
  normalizeSymbol,
  normalizeTradeBookEntry,
  extractTradeBookEntries,
  findTradeBookEntryForTrade,
  toFrontendTrade
};
