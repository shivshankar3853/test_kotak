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

async function resolveBrokerEntryPrice({
  orderId,
  sessionToken,
  sid,
  baseUrl,
  axiosInstance = require("axios")
} = {}) {
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
  waitForBrokerOrderCompletion,
  isBrokerOrderComplete
};
