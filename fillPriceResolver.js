const qs = require("qs");

async function resolveFillPrice({
  orderData = {},
  order = {},
  symbol,
  instrument,
  ltpLookup,
  tickLookup,
  maxAttempts = 3,
  delayMs = 400
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

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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

    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return 0;
}

function normalizeBrokerOrderStatus(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeBrokerSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function deriveEntryPriceFromBrokerPosition(position = {}) {
  const raw = position?.raw || position || {};

  const buyAmt = Number(raw.buyAmt || raw.cfBuyAmt || raw.buy_amount || raw.buyAmount || 0);
  const sellAmt = Number(raw.sellAmt || raw.cfSellAmt || raw.sell_amount || raw.sellAmount || 0);
  const flBuyQty = Number(raw.flBuyQty || raw.fl_buy_qty || raw.flBuy || raw.buyQty || 0);
  const flSellQty = Number(raw.flSellQty || raw.fl_sell_qty || raw.flSell || raw.sellQty || 0);
  const cfBuyQty = Number(raw.cfBuyQty || raw.cf_buy_qty || raw.cfBuy || 0);
  const cfSellQty = Number(raw.cfSellQty || raw.cf_sell_qty || raw.cfSell || 0);

  const qty = flBuyQty || cfBuyQty || 0;
  const oppositeQty = flSellQty || cfSellQty || 0;

  if (buyAmt > 0 && qty > 0) {
    return buyAmt / qty;
  }

  if (sellAmt > 0 && oppositeQty > 0) {
    return sellAmt / oppositeQty;
  }

  return 0;
}

function findBrokerPositionForSymbol(positions = [], symbol) {
  const targetSymbol = normalizeBrokerSymbol(symbol);
  if (!targetSymbol) {
    return null;
  }

  for (const position of positions) {
    const raw = position?.raw || position || {};
    const candidateSymbols = [
      raw?.trdSym,
      raw?.trdSymbol,
      raw?.tsym,
      raw?.sym,
      raw?.symbol,
      raw?.TS,
      raw?.ts,
      raw?.instrument,
      position?.trading_symbol,
      position?.instrument,
      position?.symbol,
      position?.ts
    ];

    const matched = candidateSymbols.some((candidate) => normalizeBrokerSymbol(candidate) === targetSymbol);
    if (matched) {
      return position;
    }
  }

  return null;
}

function isBrokerOrderComplete(orderDetails = {}) {
  const candidates = [];

  if (Array.isArray(orderDetails?.data)) {
    candidates.push(...orderDetails.data);
  }

  if (Array.isArray(orderDetails?.orders)) {
    candidates.push(...orderDetails.orders);
  }

  if (orderDetails?.order) {
    candidates.push(orderDetails.order);
  }

  candidates.push(orderDetails);

  for (const candidate of candidates) {
    const status = normalizeBrokerOrderStatus(
      candidate?.status ||
      candidate?.stat ||
      candidate?.orderStatus ||
      candidate?.order_status ||
      candidate?.ordStatus ||
      candidate?.ord_status ||
      candidate?.executionStatus ||
      candidate?.order_state ||
      candidate?.orderState
    );

    if ([
      "COMPLETE",
      "COMPLETED",
      "FILLED",
      "FULLY_FILLED",
      "EXECUTED",
      "TRADED",
      "SUCCESS",
      "OK"
    ].some((token) => status.includes(token))) {
      return true;
    }
  }

  return false;
}

async function fetchBrokerOrderDetails({
  orderId,
  sessionToken,
  sid,
  baseUrl,
  axiosInstance = require("axios")
} = {}) {
  if (!orderId || !sessionToken || !sid || !baseUrl) {
    return null;
  }

  const orderUrl = `${baseUrl}/quick/order/rule/ms/getOrderInfo`;
  const payload = qs.stringify({
    jData: JSON.stringify({ nOrdNo: String(orderId) }),
    jKey: sessionToken
  });

  const headers = {
    Accept: "application/json",
    Auth: sessionToken,
    Sid: sid,
    "neo-fin-key": "neotradeapi",
    "Content-Type": "application/x-www-form-urlencoded"
  };

  try {
    const response = await axiosInstance.post(orderUrl, payload, { headers, timeout: 10000 });
    const responseBody = response?.data && typeof response.data === "object" ? response.data : {};
    console.log("[order-debug] Broker order details response:", JSON.stringify(responseBody, null, 2));
    return responseBody?.data || responseBody?.order || responseBody || null;
  } catch (_) {
    return null;
  }
}

async function fetchBrokerTradeBook({
  sessionToken,
  sid,
  baseUrl,
  axiosInstance = require("axios")
} = {}) {
  if (!sessionToken || !sid || !baseUrl) {
    return null;
  }

  const tradeBookUrl = `${baseUrl}/quick/user/trades`;
  const headers = {
    Accept: "application/json",
    Auth: sessionToken,
    Sid: sid,
    "neo-fin-key": "neotradeapi"
  };

  try {
    const response = await axiosInstance.get(tradeBookUrl, { headers, timeout: 10000 });
    const responseBody = response?.data && typeof response.data === "object" ? response.data : {};
    console.log("[tradebook-debug] Raw trade book response:", JSON.stringify(responseBody, null, 2));
    return responseBody?.data || responseBody?.trades || responseBody?.orders || responseBody || null;
  } catch (_) {
    return null;
  }
}

function extractTradeBookEntryPrice(tradeBookPayload = {}, orderId = null) {
  const candidates = [];

  if (Array.isArray(tradeBookPayload)) {
    candidates.push(...tradeBookPayload);
  } else if (tradeBookPayload && typeof tradeBookPayload === "object") {
    if (Array.isArray(tradeBookPayload?.data)) {
      candidates.push(...tradeBookPayload.data);
    }
    if (Array.isArray(tradeBookPayload?.trades)) {
      candidates.push(...tradeBookPayload.trades);
    }
    if (Array.isArray(tradeBookPayload?.orders)) {
      candidates.push(...tradeBookPayload.orders);
    }
    candidates.push(tradeBookPayload);
  }

  for (const candidate of candidates) {
    if (orderId && candidate?.nOrdNo && String(candidate.nOrdNo) !== String(orderId)) {
      continue;
    }

    const priceCandidates = [
      candidate?.avgPrice,
      candidate?.averagePrice,
      candidate?.fillPrice,
      candidate?.price,
      candidate?.lastPrice,
      candidate?.avg_price,
      candidate?.average_price,
      candidate?.fill_price,
      candidate?.tradePrice,
      candidate?.trade_price,
      candidate?.entryPrice,
      candidate?.entry_price
    ];

    for (const priceCandidate of priceCandidates) {
      const numericValue = Number(priceCandidate);
      if (Number.isFinite(numericValue) && numericValue > 0) {
        return numericValue;
      }
    }
  }

  return 0;
}

async function resolveBrokerEntryPrice({
  orderId,
  sessionToken,
  sid,
  baseUrl,
  axiosInstance = require("axios")
} = {}) {
  const tradeBookPayload = await fetchBrokerTradeBook({
    sessionToken,
    sid,
    baseUrl,
    axiosInstance
  });

  const tradeBookPrice = extractTradeBookEntryPrice(tradeBookPayload, orderId);
  if (tradeBookPrice > 0) {
    return tradeBookPrice;
  }

  const orderDetails = await fetchBrokerOrderDetails({
    orderId,
    sessionToken,
    sid,
    baseUrl,
    axiosInstance
  });

  if (!orderDetails) {
    return 0;
  }

  const candidates = [
    orderDetails?.avgPrice,
    orderDetails?.fillPrice,
    orderDetails?.price,
    orderDetails?.lastPrice,
    orderDetails?.avg_price,
    orderDetails?.fill_price,
    orderDetails?.entryPrice,
    orderDetails?.entry_price,
    orderDetails?.averagePrice,
    orderDetails?.average_price,
    orderDetails?.tradePrice,
    orderDetails?.trade_price
  ];

  for (const candidate of candidates) {
    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return numericValue;
    }
  }

  return 0;
}

async function waitForBrokerOrderCompletion({
  orderId,
  sessionToken,
  sid,
  baseUrl,
  axiosInstance = require("axios"),
  pollIntervalMs = 1000,
  maxPolls = 30
} = {}) {
  let lastOrderDetails = null;

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const orderDetails = await fetchBrokerOrderDetails({
      orderId,
      sessionToken,
      sid,
      baseUrl,
      axiosInstance
    });

    if (orderDetails) {
      lastOrderDetails = orderDetails;
      if (isBrokerOrderComplete(orderDetails)) {
        return orderDetails;
      }
    }

    if (attempt < maxPolls - 1) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return lastOrderDetails;
}

module.exports = {
  resolveFillPrice,
  resolveBrokerEntryPrice,
  fetchBrokerOrderDetails,
  fetchBrokerTradeBook,
  extractTradeBookEntryPrice,
  deriveEntryPriceFromBrokerPosition,
  findBrokerPositionForSymbol,
  waitForBrokerOrderCompletion,
  isBrokerOrderComplete
};
