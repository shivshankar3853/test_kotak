function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeTradeBookEntry(entry = {}) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const instrument = raw.instrument || raw.trdSym || raw.tsym || raw.symbol || raw.sym || raw.scrip || raw.security || raw.tradeSymbol || raw.trading_symbol || "";
  const side = raw.side || raw.buySell || raw.buy_sell || raw.transactionType || raw.trnType || raw.tt || raw.action || "";
  const quantity = Number(raw.quantity || raw.qty || raw.qtty || raw.tradeQty || raw.trdQty || raw.lotQty || raw.quantityTraded || 0);
  const entryPrice = Number(
    raw.entryPrice ||
    raw.avgPrice ||
    raw.averagePrice ||
    raw.price ||
    raw.tradePrice ||
    raw.fillPrice ||
    raw.avgprice ||
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

  pushArray(payload);
  pushArray(payload?.data);
  pushArray(payload?.data?.data);
  pushArray(payload?.tradeBook);
  pushArray(payload?.trades);
  pushArray(payload?.entries);
  pushArray(payload?.result);
  pushArray(payload?.payload);

  return entries
    .map(normalizeTradeBookEntry)
    .filter((entry) => entry.instrument || entry.orderId || entry.entryPrice > 0);
}

function findTradeBookEntryForTrade(trade = {}, tradeBookEntries = []) {
  const tradeOrderId = String(trade?.orderId || trade?.brokerOrderId || "").trim();
  const tradeInstrument = normalizeSymbol(trade?.instrument || trade?.symbol || trade?.ts || "");

  for (const entry of tradeBookEntries) {
    const entryOrderId = String(entry?.orderId || "").trim();
    const entryInstrument = normalizeSymbol(entry?.instrument || entry?.raw?.trdSym || entry?.raw?.symbol || "");

    if (tradeOrderId && entryOrderId && tradeOrderId === entryOrderId) {
      return entry;
    }

    if (tradeInstrument && entryInstrument && tradeInstrument === entryInstrument) {
      return entry;
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
