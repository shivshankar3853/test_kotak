function normalizeOrderStatus(status = "") {
  const value = String(status || "").trim().toLowerCase();

  if (!value) return "UNKNOWN";
  if (value.includes("complete")) return "COMPLETE";
  if (value.includes("open")) return "OPEN";
  if (value.includes("rejected")) return "REJECTED";
  if (value.includes("cancel")) return "CANCELLED";
  if (value.includes("modify")) return "MODIFIED";
  if (value.includes("validation")) return "VALIDATION";
  return value.toUpperCase();
}

function extractOrderStreamData(message = {}) {
  const payload = message && typeof message === "object" ? message : {};
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};

  const orderId = data.nOrdNo || data.orderId || data.exOrdId || null;
  const orderStatus = normalizeOrderStatus(data.ordSt || data.status || data.orderStatus || data.state || "");
  const entryPrice = Number(
    data.avgPrc ||
    data.avgPrice ||
    data.averagePrice ||
    data.fillPrice ||
    data.price ||
    0
  );

  return {
    orderId,
    orderStatus,
    entryPrice,
    symbol: data.sym || data.trdSym || data.symbol || data.instrument || null,
    side: data.trnsTp || data.transactionType || data.side || null,
    raw: data
  };
}

function extractPositionStreamData(message = {}) {
  const payload = message && typeof message === "object" ? message : {};
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};

  const buyQty = Number(data.flBuyQty || data.buyQty || data.buyQuantity || 0);
  const sellQty = Number(data.flSellQty || data.sellQty || data.sellQuantity || 0);
  const buyAmt = Number(data.buyAmt || data.buyAmount || data.buyValue || 0);
  const sellAmt = Number(data.sellAmt || data.sellAmount || data.sellValue || 0);

  return {
    symbol: data.sym || data.trdSym || data.symbol || data.instrument || null,
    buyQty,
    sellQty,
    buyAmt,
    sellAmt,
    raw: data
  };
}

module.exports = {
  normalizeOrderStatus,
  extractOrderStreamData,
  extractPositionStreamData
};
