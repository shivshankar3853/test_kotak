const axios = require("axios");
const qs = require("qs");
const mongoose = require("mongoose");

const {
  getSessionToken,
  getSid,
  getBaseUrl
} = require("./tokenManager");
const { autoLogin } = require("./authController");

const Trade = require("./models/Trade");
const BrokerOrder = require("./models/BrokerOrder");

const { findInstrument } = require("./instrumentStore");

const {
  getLTP,
  setPostTradeCooldown
} = require("./signal");

const { getTickAsync } = require("./wsService");
const { extractTradeBookEntries, findTradeBookEntryForTrade, toFrontendTrade } = require("./tradeBookUtils");

function normalizeOrderTypeCode(orderType) {
  const rawType = String(orderType || "").trim().toUpperCase();

  if (!rawType) {
    return "MKT";
  }

  const normalizedMap = {
    LMT: "L",
    LIMIT: "L",
    L: "L",
    MKT: "MKT",
    MARKET: "MKT",
    SLM: "SL-M",
    "SL-M": "SL-M",
    SL: "SL",
    STOPLOSS: "SL",
    STOP_LOSS: "SL",
    "SL-MARKET": "SL-M"
  };

  return normalizedMap[rawType] || rawType;
}

function buildOrderPayload({
  instrument,
  action,
  qtyFinal,
  productCode,
  validity,
  orderType,
  price,
  amFlag,
  gtt = false,
  oco = false,
  orderTag = null,
  triggerPrice = null,
  ptValue = undefined
}) {
  const payload = {
    am: amFlag ? "YES" : "NO",
    dq: "0",
    es: instrument?.es || "nse_fo",
    mp: "0",
    pc: productCode,
    pf: "N",
    pr: String(price || "0"),
      pt: ptValue !== undefined ? ptValue : (gtt && triggerPrice !== null && triggerPrice !== undefined ? String(triggerPrice) : orderType),
    qt: qtyFinal,
    rt: validity || "DAY",
    tp: triggerPrice !== null && triggerPrice !== undefined ? String(triggerPrice) : "0",
    ts: instrument?.ts,
    tt: action === "BUY" ? "B" : "S"
  };

  if (gtt) {
    payload.gtt = "Y";
  }
  if (oco) {
    payload.oco = "Y";
  }
  if (orderTag) {
    payload.tag = orderTag;
  }

  return payload;
}

function calculateChildPrices({ action, fillPrice, targetPoints, stopLossPoints }) {
  const targetPrice = action === "BUY" ? fillPrice + targetPoints : fillPrice - targetPoints;
  const stopLossPrice = action === "BUY" ? fillPrice - stopLossPoints : fillPrice + stopLossPoints;
  return { targetPrice, stopLossPrice };
}

function buildChildOrderPayloads({
  instrument,
  action,
  qtyFinal,
  productCode,
  validity,
  fillPrice,
  targetPoints,
  stopLossPoints,
  childOrderType = "MKT"
}) {
  const hasTP = Number.isFinite(targetPoints) && targetPoints > 0;
  const hasSL = Number.isFinite(stopLossPoints) && stopLossPoints > 0;

  if (!hasTP && !hasSL) {
    return [];
  }

  if (!fillPrice || isNaN(fillPrice) || fillPrice <= 0) {
    throw new Error("fillPrice is required before building child GTT/OCO payloads");
  }

  const { targetPrice, stopLossPrice } = calculateChildPrices({
    action,
    fillPrice,
    targetPoints,
    stopLossPoints
  });

  const normalizedChildOrderType = normalizeOrderTypeCode(childOrderType);
  const isBuy = action === "BUY";
  const oppositeAction = isBuy ? "SELL" : "BUY";
  const childOrders = [];

  if (hasTP && hasSL) {
    childOrders.push({
      tag: "TP",
      jData: buildOrderPayload({
        instrument,
        action: oppositeAction,
        qtyFinal,
        productCode,
        validity,
        orderType: normalizedChildOrderType,
        ptValue: normalizedChildOrderType,
        price: targetPrice,
        amFlag: false,
        gtt: true,
        oco: true,
        orderTag: "TP",
        triggerPrice: targetPrice
      })
    });

    childOrders.push({
      tag: "SL",
      jData: buildOrderPayload({
        instrument,
        action: oppositeAction,
        qtyFinal,
        productCode,
        validity,
        orderType: normalizedChildOrderType,
        ptValue: normalizedChildOrderType,
        price: stopLossPrice,
        amFlag: false,
        gtt: true,
        oco: true,
        orderTag: "SL",
        triggerPrice: stopLossPrice
      })
    });
  } else if (hasTP) {
    childOrders.push({
      tag: "TP",
      jData: buildOrderPayload({
        instrument,
        action: oppositeAction,
        qtyFinal,
        productCode,
        validity,
        orderType: normalizedChildOrderType,
        ptValue: normalizedChildOrderType,
        price: targetPrice,
        amFlag: false,
        gtt: true,
        oco: false,
        orderTag: "TP",
        triggerPrice: targetPrice
      })
    });
  } else if (hasSL) {
    childOrders.push({
      tag: "SL",
      jData: buildOrderPayload({
        instrument,
        action: oppositeAction,
        qtyFinal,
        productCode,
        validity,
        orderType: normalizedChildOrderType,
        ptValue: normalizedChildOrderType,
        price: stopLossPrice,
        amFlag: false,
        gtt: true,
        oco: false,
        orderTag: "SL",
        triggerPrice: stopLossPrice
      })
    });
  }

  return childOrders;
}

function selectLatestBrokerOrderForPlacement({ currentBrokerOrder, targetSymbol, latestBrokerOrder }) {
  if (!targetSymbol) {
    return currentBrokerOrder || latestBrokerOrder || null;
  }

  if (!latestBrokerOrder) {
    return currentBrokerOrder || null;
  }

  const latestSymbol = String(latestBrokerOrder?.symbol || "").trim();
  if (latestSymbol && latestSymbol !== targetSymbol) {
    return currentBrokerOrder || null;
  }

  const currentId = currentBrokerOrder?._id?.toString?.() || "";
  const latestId = latestBrokerOrder?._id?.toString?.() || "";
  if (!currentId || currentId !== latestId) {
    return latestBrokerOrder;
  }

  return currentBrokerOrder || latestBrokerOrder || null;
}

function shouldPlaceChildOrdersForConfirmation({ brokerOrder, orderStreamData, resolvedEntryPrice = 0 }) {
  if (!brokerOrder || brokerOrder.childOrdersPlaced || brokerOrder.childOrdersPlacementTriggered) {
    return false;
  }

  const entryPrice = Number(resolvedEntryPrice || orderStreamData?.entryPrice || brokerOrder?.entryPrice || 0);
  const hasBrokerOrderId = Boolean(brokerOrder?.brokerOrderId || orderStreamData?.orderId);
  const orderStatus = String(orderStreamData?.orderStatus || "").trim().toUpperCase();
  const isTerminalRejected = ["REJECTED", "FAILED", "CANCELLED"].includes(orderStatus);

  if (isTerminalRejected) {
    return false;
  }

  return hasBrokerOrderId && entryPrice > 0;
}

async function resolvePriceWithTickFirst({
  symbol,
  instrument,
  getTickValue = async (rawSymbol) => (getTickAsync ? getTickAsync(rawSymbol) : 0),
  getLtpValue = async (rawSymbol, exchange) => getLTP(rawSymbol, exchange)
}) {
  const rawSymbol = String(symbol || "").trim();
  if (!rawSymbol) {
    return 0;
  }

  try {
    const tickValue = await getTickValue(rawSymbol);
    const tickPrice = Number(tickValue) || 0;
    if (tickPrice > 0) {
      return tickPrice;
    }
  } catch (tickErr) {
    console.log("⚠️ Could not fetch WS tick for price resolution:", tickErr?.message || tickErr);
  }

  try {
    const ltpValue = await getLtpValue(rawSymbol, instrument?.es);
    const ltpPrice = Number(ltpValue) || 0;
    if (ltpPrice > 0) {
      return ltpPrice;
    }
  } catch (ltpErr) {
    console.log("⚠️ Could not fetch fallback LTP for price resolution:", ltpErr?.message || ltpErr);
  }

  return 0;
}

async function resolveBrokerConfirmationPrice({ brokerOrder, orderStreamData, sessionToken, sid, baseUrl }) {
  const entryPrice = Number(orderStreamData?.entryPrice || brokerOrder?.entryPrice || 0);
  if (entryPrice > 0) {
    return entryPrice;
  }

  const brokerOrderId = brokerOrder?.brokerOrderId || orderStreamData?.orderId || null;
  const rawSymbol = brokerOrder?.symbol || orderStreamData?.symbol || "";
  const instrument = findInstrument(rawSymbol);

  if (rawSymbol) {
    const tickFirstPrice = await resolvePriceWithTickFirst({
      symbol: rawSymbol,
      instrument,
      getTickValue: async (rawSymbolValue) => (getTickAsync ? getTickAsync(rawSymbolValue) : 0),
      getLtpValue: async (rawSymbolValue, exchange) => getLTP(rawSymbolValue, exchange)
    });

    if (tickFirstPrice > 0) {
      return tickFirstPrice;
    }
  }

  if (!brokerOrderId || !sessionToken || !sid || !baseUrl) {
    return 0;
  }

  try {
    const tradeBookUrl = `${baseUrl}/quick/user/trades`;
    const tradeBookRes = await axios.get(tradeBookUrl, {
      headers: {
        Auth: sessionToken,
        Sid: sid,
        "neo-fin-key": "neotradeapi"
      },
      timeout: 10000
    });

    const tradeBookEntries = extractTradeBookEntries(tradeBookRes?.data || {});
    const matchingEntry = findTradeBookEntryForTrade({
      instrument: brokerOrder?.symbol,
      side: brokerOrder?.side,
      quantity: brokerOrder?.quantity,
      orderId: brokerOrderId
    }, tradeBookEntries);

    const resolvedPrice = Number(matchingEntry?.entryPrice || matchingEntry?.raw?.avgPrc || matchingEntry?.raw?.avgPrice || 0);
    if (resolvedPrice > 0) {
      return resolvedPrice;
    }
  } catch (tradeBookErr) {
    console.log("⚠️ Could not resolve broker confirmation price from trade book:", tradeBookErr?.message || tradeBookErr);
    return 0;
  }
}

async function placeGttOcoChildOrdersOnConfirmation({
  brokerOrder,
  orderStreamData,
  sessionToken,
  sid,
  baseUrl
}) {
  let persistedBrokerOrder = brokerOrder;
  const targetSymbol = String(brokerOrder?.symbol || orderStreamData?.symbol || "").trim();

  if (targetSymbol) {
    try {
      const latestOrder = await BrokerOrder.findOne({
        symbol: targetSymbol,
        status: { $in: ["PENDING_CONFIRMATION", "PENDING", "SUCCESS", "COMPLETED", "OPEN"] }
      }).sort({ placedAt: -1, createdAt: -1 });
      persistedBrokerOrder = selectLatestBrokerOrderForPlacement({
        currentBrokerOrder: persistedBrokerOrder,
        targetSymbol,
        latestBrokerOrder: latestOrder
      });
    } catch (lookupErr) {
      console.log("⚠️ Could not resolve latest broker order:", lookupErr?.message || lookupErr);
    }
  }
  let confirmedEntryPrice = Number(orderStreamData?.entryPrice || brokerOrder?.entryPrice || 0);

  if (!confirmedEntryPrice || confirmedEntryPrice <= 0) {
    confirmedEntryPrice = await resolveBrokerConfirmationPrice({
      brokerOrder,
      orderStreamData,
      sessionToken,
      sid,
      baseUrl
    });
  }

  const placementOrderId = persistedBrokerOrder?._id || brokerOrder?._id;
  if (placementOrderId && confirmedEntryPrice > 0) {
    try {
      persistedBrokerOrder = await BrokerOrder.findByIdAndUpdate(
        placementOrderId,
        {
          entryPrice: confirmedEntryPrice,
          brokerOrderId: persistedBrokerOrder.brokerOrderId || orderStreamData?.orderId || null,
          brokerStatus: orderStreamData?.orderStatus || persistedBrokerOrder.brokerStatus,
          status: orderStreamData?.orderStatus === "COMPLETE" ? "COMPLETED" : persistedBrokerOrder.status
        },
        { returnDocument: "after" }
      );
    } catch (persistErr) {
      console.log("⚠️ Could not persist confirmed entry price:", persistErr?.message || persistErr);
    }
  }

  if (!shouldPlaceChildOrdersForConfirmation({ brokerOrder: persistedBrokerOrder, orderStreamData, resolvedEntryPrice: confirmedEntryPrice })) {
    console.log("⚠️ Skipping child GTT/OCO placement because a placement request is already in progress or the order is already completed");
    return null;
  }

  if (placementOrderId) {
    try {
      await BrokerOrder.findByIdAndUpdate(
        placementOrderId,
        {
          childOrdersPlacementTriggered: true,
          childOrdersPlacementTriggeredAt: new Date()
        },
        { returnDocument: "after" }
      );
    } catch (guardErr) {
      console.log("⚠️ Could not place child-order placement guard:", guardErr?.message || guardErr);
    }
  }

  if (targetSymbol && persistedBrokerOrder?.symbol && String(persistedBrokerOrder.symbol).trim() !== targetSymbol) {
    console.log(`⚠️ Latest broker order symbol ${persistedBrokerOrder.symbol} did not match target ${targetSymbol}; using the latest matching record`);
  }

  const orderPayload = persistedBrokerOrder?.requestPayload?.order || brokerOrder?.requestPayload?.order || {};
  const action = String(persistedBrokerOrder?.side || brokerOrder?.side || orderPayload?.transaction_type || "")
    .trim()
    .toUpperCase();

  const rawSymbol = persistedBrokerOrder?.symbol || brokerOrder?.symbol || orderPayload?.TS || orderStreamData?.symbol || "";
  const instrument = findInstrument(rawSymbol);
  const lotSize = Number(instrument?.ls || 0);
  const quantity = Number(brokerOrder?.quantity || orderPayload?.quantity || 0);
  const qtyFinal = lotSize > 0 ? String(quantity * lotSize) : String(quantity || 0);

  const rawTP = orderPayload?.TP || orderPayload?.tp || orderPayload?.TGT || orderPayload?.target_point || orderPayload?.targetPoints || orderPayload?.target_points || orderPayload?.targetPrice;
  const rawSLP = orderPayload?.SLP || orderPayload?.slp || orderPayload?.stop_loss || orderPayload?.stopLoss || orderPayload?.sl || orderPayload?.stop_loss_points || orderPayload?.stopLossPoint;
  const targetPoints = Number(rawTP);
  const stopLossPoints = Number(rawSLP);
  const targetPointsFinal = Number.isFinite(targetPoints) && targetPoints > 0 ? targetPoints : 0;
  const stopLossPointsFinal = Number.isFinite(stopLossPoints) && stopLossPoints > 0 ? stopLossPoints : 0;

  const productCode = persistedBrokerOrder?.requestPayload?.jData?.pc || brokerOrder?.requestPayload?.jData?.pc || "CNC";
  const validity = persistedBrokerOrder?.validity || brokerOrder?.validity || orderPayload?.validity || orderPayload?.VL || "DAY";
  const fillPrice = Number(confirmedEntryPrice || orderStreamData?.entryPrice || persistedBrokerOrder?.entryPrice || brokerOrder?.entryPrice || 0);

  console.log(`🧩 Placing child GTT/OCO orders for ${rawSymbol} using entry price ${fillPrice}`);

  const childOrders = await placeGttOcoChildOrders({
    order: orderPayload,
    instrument,
    action,
    qtyFinal,
    productCode,
    validity,
    fillPrice,
    targetPoints: targetPointsFinal,
    stopLossPoints: stopLossPointsFinal,
    amFlag: false,
    sessionToken,
    sid,
    baseUrl,
    brokerOrderId: persistedBrokerOrder?._id || brokerOrder?._id
  });

  try {
    await BrokerOrder.findByIdAndUpdate(persistedBrokerOrder?._id || brokerOrder?._id, {
      childOrdersPlaced: true,
      childOrdersPlacedAt: new Date(),
      childOrdersPlacementTriggered: false,
      entryPrice: fillPrice > 0 ? fillPrice : undefined,
      brokerOrderId: persistedBrokerOrder?.brokerOrderId || brokerOrder.brokerOrderId || orderStreamData?.orderId || null,
      brokerStatus: orderStreamData?.orderStatus || brokerOrder.brokerStatus,
      status: orderStreamData?.orderStatus === "COMPLETE" ? "COMPLETED" : brokerOrder.status
    }, { returnDocument: "after" });
  } catch (err) {
    console.error("❌ Failed to mark child GTT/OCO orders as placed:", err.message || err);
  }

  return childOrders;
}

async function postKotakOrder(jData, authToken, sidVal, baseUrlArg) {
  const targetBase = baseUrlArg || getBaseUrl();
  const orderUrl = `${targetBase}/quick/order/rule/ms/place`;
  const payload = qs.stringify({ jData: JSON.stringify(jData), jKey: authToken });
  const headers = {
    Accept: "application/json",
    Auth: authToken,
    Sid: sidVal,
    "neo-fin-key": "neotradeapi",
    "Content-Type": "application/x-www-form-urlencoded"
  };
  return axios.post(orderUrl, payload, { headers, timeout: 10000 });
}

async function placeGttOcoChildOrders({
  order,
  instrument,
  action,
  qtyFinal,
  productCode,
  validity,
  fillPrice,
  targetPoints,
  stopLossPoints,
  amFlag,
  sessionToken,
  sid,
  baseUrl,
  brokerOrderId
}) {
  const rawChildOrderType = order?.order_type || order?.OT || order?.orderType || order?.type || "MKT";
  const childOrders = buildChildOrderPayloads({
    instrument,
    action,
    qtyFinal,
    productCode,
    validity,
    fillPrice,
    targetPoints,
    stopLossPoints,
    childOrderType: rawChildOrderType
  });

  if (!childOrders.length) {
    return [];
  }

  console.log("📐 Child order price computation", JSON.stringify({
    fillPrice,
    targetPoints,
    stopLossPoints,
    targetPrice: calculateChildPrices({ action, fillPrice, targetPoints, stopLossPoints }).targetPrice,
    stopLossPrice: calculateChildPrices({ action, fillPrice, targetPoints, stopLossPoints }).stopLossPrice
  }));

  const childResults = [];

  for (const child of childOrders) {
    try {
      console.log("📦 GTT child payload before placement:", JSON.stringify({
        tag: child.tag,
        payload: child.jData,
        fillPrice,
        action,
        qtyFinal,
        productCode,
        validity
      }, null, 2));

      console.log(`📤 Sending ${child.tag} GTT payload to broker`, JSON.stringify(child.jData));
      const response = await postKotakOrder(child.jData, sessionToken, sid, baseUrl);
      const responseBody = response?.data && typeof response.data === "object" ? response.data : {};
      console.log(`✅ GTT ${child.tag} response`, JSON.stringify(responseBody));
      childResults.push({
        tag: child.tag,
        status: responseBody?.status || responseBody?.stat || responseBody?.order_status || responseBody?.orderStatus || "UNKNOWN",
        response: responseBody,
        payload: child.jData
      });
    } catch (err) {
      console.error(`❌ GTT ${child.tag} error`, err?.response?.status, err?.response?.data || err.message);
      childResults.push({
        tag: child.tag,
        error: err?.response?.data || err.message,
        payload: child.jData
      });
    }
  }

  if (brokerOrderId) {
    try {
      await BrokerOrder.findByIdAndUpdate(brokerOrderId, { childOrders: childResults });
    } catch (err) {
      console.error("❌ Failed to save child GTT/OCO orders:", err.message || err);
    }
  }

  return childResults;
}

async function placeOrder(order, signalId = null) {

  try {

    const sessionToken = getSessionToken();
    const sid = getSid();
    const baseUrl = getBaseUrl();

    // ==============================
    // 🧯 SAFE GUARD
    // ==============================
    if (!sessionToken || !sid || !baseUrl) {
      throw new Error("Missing auth/session/baseUrl");
    }

    // ==============================
    // ✅ VALIDATION
    // ==============================
    const action = (order?.transaction_type || "")
      .trim()
      .toUpperCase();

    const quantity = Number(order?.quantity);

    const rawSymbol = order?.TS;

    if (!action || !["BUY", "SELL"].includes(action)) {
      throw new Error("Invalid Action: " + action);
    }

    if (!rawSymbol) {
      throw new Error("Symbol missing");
    }

    if (!quantity || isNaN(quantity)) {
      throw new Error("Invalid quantity");
    }

    // ==============================
    // 🔍 FIND INSTRUMENT
    // ==============================
    console.log("🔍 Searching Instrument:", rawSymbol);

    const instrument = findInstrument(rawSymbol);

    if (!instrument) {
      throw new Error("Instrument not found for: " + rawSymbol);
    }

    const symbol = instrument?.ts || rawSymbol;

    const lotSize = Number(instrument?.ls);

    if (!lotSize || isNaN(lotSize)) {
      throw new Error("Invalid lot size");
    }

    // ==============================
    // 🚀 BUILD ORDER
    // ==============================
    const qtyFinal = String((quantity || 0) * lotSize);

    const rawAmo =
      order?.AMO ||
      order?.amo ||
      order?.after_market ||
      order?.afterMarket ||
      order?.am ||
      "";

    const amoValue = String(rawAmo).trim().toUpperCase();
    const amFlag = ["YES", "Y", "TRUE", "1", "AMO"].includes(amoValue)
      ? "YES"
      : "NO";

    const rawTP =
      order?.TP ||
      order?.tp ||
      order?.TGT ||
      order?.target_point ||
      order?.targetPoints ||
      order?.target_points ||
      order?.targetPrice;
    const rawSLP =
      order?.SLP ||
      order?.slp ||
      order?.stop_loss ||
      order?.stopLoss ||
      order?.sl ||
      order?.stop_loss_points ||
      order?.stopLossPoint;
    const rawPrice =
      order?.PRICE ||
      order?.price ||
      order?.limit_price ||
      order?.trigger_price ||
      order?.triggerPrice ||
      0;
    const rawValidity =
      order?.validity ||
      order?.VL ||
      order?.time_in_force ||
      order?.timeInForce ||
      "DAY";
    const rawProduct =
      order?.product ||
      order?.P ||
      order?.product_type ||
      order?.productType ||
      "NRML";
    const rawOrderType =
      order?.order_type ||
      order?.OT ||
      order?.orderType ||
      order?.type ||
      "MARKET";

    const targetPoints = Number(rawTP);
    const stopLossPoints = Number(rawSLP);
    const priceValue = Number(rawPrice);
    const targetPointsFinal =
      Number.isFinite(targetPoints) && targetPoints > 0
        ? targetPoints
        : 0;
    const stopLossPointsFinal =
      Number.isFinite(stopLossPoints) && stopLossPoints > 0
        ? stopLossPoints
        : 0;

    const orderType = String(rawOrderType).trim().toUpperCase();
    const normalizedOrderType = normalizeOrderTypeCode(orderType);

    const orderTypeMap = {
      MKT: { pt: "MKT", pr: "0" },
      L: { pt: "L", pr: String(priceValue > 0 ? priceValue : 0) },
      SL: { pt: "SL", pr: String(priceValue > 0 ? priceValue : 0) },
      "SL-M": { pt: "SL-M", pr: "0" }
    };

    if (
      ["L", "SL", "SL-M"].includes(normalizedOrderType) &&
      (!priceValue || isNaN(priceValue))
    ) {
      throw new Error("Limit/stop orders require a valid PRICE value");
    }

    const productMap = {
      CNC: "CNC",
      MIS: "MIS",
      NRML: "NRML",
      BO: "BO",
      CO: "CO"
    };

    const validityMap = {
      DAY: "DAY",
      IOC: "IOC",
      GFD: "GFD"
    };

    const orderSpec = orderTypeMap[normalizedOrderType] || orderTypeMap.MKT;

    const jData = {
      am: amFlag,
      dq: "0",
      es: instrument?.es || "nse_fo",
      mp: "0",
      pc:
        productMap[String(rawProduct).trim().toUpperCase()] || "CNC",
      pf: "N",
      pr: orderSpec.pr,
      pt: orderSpec.pt,
      qt: qtyFinal,
      rt:
        validityMap[String(rawValidity).trim().toUpperCase()] || "DAY",
      tp: "0",
      ts: symbol,
      tt: action === "BUY" ? "B" : "S"
    };

    let brokerOrderDoc = null;
    try {
      brokerOrderDoc = await BrokerOrder.create({
        signalId,
        symbol,
        side: action,
        quantity,
        product: order?.product || "NRML",
        orderType: order?.order_type || order?.OT || "MARKET",
        validity: order?.validity || order?.VL || "DAY",
        amo: order?.AMO || order?.amo || order?.after_market || order?.afterMarket || order?.am || "NO",
        targetPrice: Number(order?.TP || order?.TGT || order?.targetPrice || 0),
        stopLossPoint: Number(order?.SLP || order?.slp || order?.stop_loss || order?.stopLoss || order?.sl || order?.stop_loss_points || order?.stopLossPoint || 0),
        requestPayload: {
          order,
          jData
        },
        childOrders: [],
        status: "PENDING",
        placedAt: new Date()
      });
    } catch (e) {
      console.error(`❌ BrokerOrder create failed: ${e.message}`);
    }

    let response;
    let retriedAfterRefresh = false;

    try {
      response = await postKotakOrder(jData, sessionToken, sid, baseUrl);
    } catch (err) {
      if (err.response?.status === 403) {
        console.error("🔴 403 Forbidden - Possible reasons: expired session, invalid Sid, rate limit, or payload format");
        console.error("Response:", err.response?.data);
      }

      if (err.response?.status === 401 && !retriedAfterRefresh) {
        retriedAfterRefresh = true;
        try {
          const refreshResult = await autoLogin();
          if (refreshResult && refreshResult.success) {
            const newToken = getSessionToken();
            const newSid = getSid();
            const newBase = getBaseUrl();
            response = await postKotakOrder(jData, newToken, newSid, newBase);
          } else {
            console.error("Auto-login did not refresh session:", refreshResult);
          }
        } catch (refreshErr) {
          console.error("Auto-login retry failed:", refreshErr?.message || refreshErr);
        }
      }

      if (!response) {
        throw err;
      }
    }

    const orderData =
      (response?.data && typeof response.data === "object")
        ? response.data
        : {};

    const brokerStatus =
      orderData?.status || orderData?.stat || orderData?.order_status || orderData?.orderStatus || null;

    const statusValue =
      brokerStatus && /rejected|fail|not_ok/i.test(String(brokerStatus))
        ? "REJECTED"
        : "SUCCESS";

    let childOrders = [];

    if (brokerOrderDoc?._id) {
      const brokerOrderId = orderData?.nOrdNo || orderData?.orderId || null;
      const initialFillPrice = Number(
        orderData?.fillPrice ||
        orderData?.avgPrice ||
        orderData?.price ||
        orderData?.lastPrice ||
        0
      );

      await BrokerOrder.findByIdAndUpdate(brokerOrderDoc._id, {
        brokerOrderId,
        entryPrice: initialFillPrice > 0 ? initialFillPrice : undefined,
        brokerStatus,
        response: orderData,
        status: statusValue === "SUCCESS" ? "PENDING_CONFIRMATION" : statusValue,
        childOrders,
        completedAt: statusValue === "SUCCESS" ? null : new Date()
      });

      if (statusValue === "SUCCESS" && brokerOrderId && sessionToken && sid && baseUrl) {
        const triggerChildOrderPlacement = async () => {
          try {
            const latestBrokerOrder = await BrokerOrder.findById(brokerOrderDoc._id);
            if (!latestBrokerOrder || latestBrokerOrder.childOrdersPlaced || latestBrokerOrder.childOrdersPlacementTriggered) {
              return;
            }

            await new Promise((resolve) => setTimeout(resolve, 12000));

            const reloadedBrokerOrder = await BrokerOrder.findById(brokerOrderDoc._id);
            if (!reloadedBrokerOrder || reloadedBrokerOrder.childOrdersPlaced || reloadedBrokerOrder.childOrdersPlacementTriggered) {
              return;
            }

            await placeGttOcoChildOrdersOnConfirmation({
              brokerOrder: reloadedBrokerOrder,
              orderStreamData: {
                orderId: brokerOrderId,
                orderStatus: initialFillPrice > 0 ? "COMPLETE" : "PENDING",
                entryPrice: initialFillPrice
              },
              sessionToken,
              sid,
              baseUrl
            });
          } catch (retryErr) {
            console.log("⚠️ Deferred child-order retry failed:", retryErr?.message || retryErr);
          }
        };

        triggerChildOrderPlacement();
      }
    }

    // ==============================
    // 🔥 POST TRADE SAFETY
    // ==============================
    try {
      setPostTradeCooldown();
    } catch (e) {
      console.log("⚠️ Cooldown Error:", e.message);
    }

    await new Promise(r => setTimeout(r, 2000));

    // ==============================
    // 📊 GET LTP SAFELY
    // ==============================
    let tradePrice = 0;

    try {
      tradePrice = await resolvePriceWithTickFirst({
        symbol,
        instrument,
        getTickValue: async (rawSymbol) => (getTickAsync ? getTickAsync(rawSymbol) : 0),
        getLtpValue: async (rawSymbol, exchange) => getLTP(rawSymbol, exchange)
      });
    } catch (e) {
      tradePrice = 0;
    }

    if (tradePrice < 0 || isNaN(tradePrice)) {
      tradePrice = 0;
    }

    const targetPrice =
      action === "BUY"
        ? tradePrice + targetPointsFinal
        : tradePrice - targetPointsFinal;
    const stopLossPrice =
      action === "BUY"
        ? tradePrice - stopLossPointsFinal
        : tradePrice + stopLossPointsFinal;

    // ==============================
    // ⚠️ DB CHECK
    // ==============================
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      console.log("⚠️ MongoDB not ready");
      return orderData;
    }

    // ==============================
    // 🟢 BUY ENTRY
    // ==============================
    if (action === "BUY") {

      await Trade.create({
        broker: "KOTAK",
        side: "BUY",
        quantity,
        instrument: symbol,
        orderId: orderData?.nOrdNo || "NA",
        price: tradePrice,
        entryPrice: tradePrice,
        targetPrice,
        targetPoints: targetPointsFinal,
        stopLossPoints: stopLossPointsFinal,
        stopLossPrice,
        status: "OPEN",
        time: new Date(),
        highestPrice: tradePrice,
        trailingSL: tradePrice > 0 ? tradePrice - 10 : 0
      });

      console.log("🟢 BUY Trade Recorded");
    }

    // ==============================
    // 🔴 SELL EXIT
    // ==============================
    else {

      const openTrade = await Trade.findOne({
        instrument: symbol,
        status: "OPEN",
        broker: "KOTAK"
      });

      if (openTrade) {

        const entryPrice = Number(openTrade.price) || 0;

        let pnl = 0;

        if (openTrade.side === "BUY") {
          pnl = (tradePrice - entryPrice) * quantity;
        } else {
          pnl = (entryPrice - tradePrice) * quantity;
        }

        openTrade.status = "CLOSED";
        openTrade.pnl = pnl;
        openTrade.exitPrice = tradePrice;
        openTrade.exitTime = new Date();

        await openTrade.save();

        await Trade.create({
          broker: "KOTAK",
          side: "SELL",
          quantity,
          instrument: symbol,
          orderId: orderData?.nOrdNo || "NA",
          price: tradePrice,
          status: "CLOSED",
          pnl,
          targetPoints: targetPointsFinal,
          stopLossPoints: stopLossPointsFinal,
          stopLossPrice,
          time: new Date()
        });

        console.log("💰 Trade Closed | PnL:", pnl);

      } else {
        console.log("⚠️ No OPEN trade found");
      }
    }

    // ==============================
    // 📡 SOCKET UPDATE
    // ==============================
    if (global.io) {
      global.io.emit("order", orderData);
    }

    return orderData;

  } catch (err) {

    console.error(
      "❌ Order Error:",
      err?.response?.data || err.message
    );

    try {
      if (brokerOrderDoc?._id) {
        await BrokerOrder.findByIdAndUpdate(brokerOrderDoc._id, {
          status: "FAILED",
          error: err?.response?.data || err.message || "Order failed",
          completedAt: new Date(),
          response: err?.response?.data || null
        });
      }
    } catch (updateErr) {
      console.error(`❌ BrokerOrder failure update error: ${updateErr.message}`);
    }

    throw err;
  }
}

// ==============================
// 📜 GET TRADE LOG
// ==============================
async function getTradeLog() {

  try {

    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      console.log("⚠️ MongoDB not ready");
      return [];
    }

    const trades = await Trade.find({ broker: "KOTAK" })
      .sort({ time: -1 });

    const sessionToken = getSessionToken();
    const sid = getSid();
    const baseUrl = getBaseUrl();

    let tradeBookEntries = [];

    if (sessionToken && sid && baseUrl) {
      try {
        const tradeBookUrl = `${baseUrl}/quick/user/trades`;
        const tradeBookRes = await axios.get(tradeBookUrl, {
          headers: {
            Auth: sessionToken,
            Sid: sid,
            "neo-fin-key": "neotradeapi"
          },
          timeout: 10000
        });

        tradeBookEntries = extractTradeBookEntries(tradeBookRes?.data || {});
      } catch (tradeBookErr) {
        console.error("⚠️ Failed to fetch trade book:", tradeBookErr?.response?.data || tradeBookErr.message || tradeBookErr);
      }
    }

    return trades.map((trade) => {
      const tradeObject = trade.toObject ? trade.toObject() : trade;
      const matchingTradeBookEntry = findTradeBookEntryForTrade(tradeObject, tradeBookEntries);
      const frontendTrade = toFrontendTrade(tradeObject, matchingTradeBookEntry);

      if (matchingTradeBookEntry?.entryPrice > 0) {
        const brokerEntryPrice = Number(matchingTradeBookEntry.entryPrice);
        const brokerOrderId = matchingTradeBookEntry?.orderId || frontendTrade.orderId || tradeObject.orderId || null;
        Trade.findByIdAndUpdate(trade._id, {
          $set: {
            entryPrice: brokerEntryPrice,
            price: brokerEntryPrice,
            orderId: brokerOrderId || tradeObject.orderId || null
          }
        }).catch((persistErr) => {
          console.error("⚠️ Failed to persist broker entry price:", persistErr.message || persistErr);
        });
      }

      return frontendTrade;
    });

  } catch (err) {
    console.error("❌ getTradeLog Error:", err.message);
    return [];
  }
}

// ==============================
// Exit existing broker position then open new one (atomic helper)
// ==============================
async function exitAndReenter(currentPosition, newOrder, signalId = null) {
  try {
    if (!currentPosition || !newOrder) return null;

    const curSide = String(currentPosition.side || currentPosition.transaction_type || "").trim().toUpperCase();
    const exitSide = curSide === "BUY" ? "SELL" : "BUY";
    const exitQty = Number(currentPosition.quantity || currentPosition.qty || currentPosition.Q || newOrder.quantity) || newOrder.quantity;

    // Place market exit order for the existing position
    const exitOrder = {
      TS: newOrder.TS || newOrder.ts || newOrder.symbol,
      quantity: exitQty,
      transaction_type: exitSide,
      order_type: "MARKET",
      product: newOrder.product || "NRML",
      validity: "DAY"
    };

    console.log(`🔁 exitAndReenter: exiting ${exitSide} ${exitQty} for ${exitOrder.TS}`);

    const exitRes = await placeOrder(exitOrder, signalId);

    // Small delay to let broker/process update positions
    await new Promise((r) => setTimeout(r, 1500));

    console.log(`🔁 exitAndReenter: placing new order ${newOrder.transaction_type} ${newOrder.quantity} for ${newOrder.TS}`);

    const newRes = await placeOrder(newOrder, signalId);

    return { exitRes, newRes };
  } catch (err) {
    console.error("❌ exitAndReenter failed:", err.message || err);
    throw err;
  }
}

module.exports = {
  placeOrder,
  getTradeLog,
  exitAndReenter,
  shouldPlaceChildOrdersForConfirmation,
  resolveBrokerConfirmationPrice,
  resolvePriceWithTickFirst,
  buildChildOrderPayloads,
  placeGttOcoChildOrdersOnConfirmation,
  placeGttOcoChildOrders,
  selectLatestBrokerOrderForPlacement
};