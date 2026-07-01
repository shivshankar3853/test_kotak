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
  orderTag = null
}) {
  const payload = {
    am: amFlag ? "YES" : "NO",
    dq: "0",
    es: instrument?.es || "nse_fo",
    mp: "0",
    pc: productCode,
    pf: "N",
    pr: String(price || "0"),
    pt: orderType,
    qt: qtyFinal,
    rt: gtt ? "GTT" : validity || "DAY",
    tp: "0",
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

function shouldPlaceChildOrdersForConfirmation({ brokerOrder, orderStreamData, resolvedEntryPrice = 0 }) {
  if (!brokerOrder || brokerOrder.childOrdersPlaced) {
    return false;
  }

  const entryPrice = Number(resolvedEntryPrice || orderStreamData?.entryPrice || brokerOrder?.entryPrice || 0);
  const hasBrokerOrderId = Boolean(brokerOrder?.brokerOrderId || orderStreamData?.orderId);
  const orderStatus = String(orderStreamData?.orderStatus || "").trim().toUpperCase();
  const hasCompletionSignal = orderStatus === "COMPLETE" || (!orderStatus && entryPrice > 0);

  return hasBrokerOrderId && entryPrice > 0 && hasCompletionSignal;
}

async function resolveBrokerConfirmationPrice({ brokerOrder, orderStreamData, sessionToken, sid, baseUrl }) {
  const entryPrice = Number(orderStreamData?.entryPrice || brokerOrder?.entryPrice || 0);
  if (entryPrice > 0) {
    return entryPrice;
  }

  const brokerOrderId = brokerOrder?.brokerOrderId || orderStreamData?.orderId || null;
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

    return Number(matchingEntry?.entryPrice || matchingEntry?.raw?.avgPrc || matchingEntry?.raw?.avgPrice || 0);
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
  const confirmedEntryPrice = await resolveBrokerConfirmationPrice({
    brokerOrder,
    orderStreamData,
    sessionToken,
    sid,
    baseUrl
  });

  if (!shouldPlaceChildOrdersForConfirmation({ brokerOrder, orderStreamData, resolvedEntryPrice: confirmedEntryPrice })) {
    return null;
  }

  const orderPayload = brokerOrder?.requestPayload?.order || {};
  const action = String(brokerOrder?.side || orderPayload?.transaction_type || "")
    .trim()
    .toUpperCase();

  const rawSymbol = brokerOrder?.symbol || orderPayload?.TS || orderStreamData?.symbol || "";
  const instrument = findInstrument(rawSymbol);
  const lotSize = Number(instrument?.ls || 0);
  const quantity = Number(brokerOrder?.quantity || orderPayload?.quantity || 0);
  const qtyFinal = lotSize > 0 ? String(quantity * lotSize) : String(quantity || 0);

  const rawTP = orderPayload?.TP || orderPayload?.tp || orderPayload?.TGT || orderPayload?.target_point || orderPayload?.targetPoints || orderPayload?.target_points || orderPayload?.targetPrice;
  const rawSLP = orderPayload?.SLP || orderPayload?.slp || orderPayload?.stop_loss || orderPayload?.stopLoss || orderPayload?.sl || orderPayload?.stop_loss_points || orderPayload?.stopLossPoint;
  const targetPoints = Number(rawTP);
  const stopLossPoints = Number(rawSLP);
  const targetPointsFinal = Number.isFinite(targetPoints) && targetPoints > 0 ? targetPoints : 10;
  const stopLossPointsFinal = Number.isFinite(stopLossPoints) && stopLossPoints > 0 ? stopLossPoints : 100;

  const productCode = brokerOrder?.requestPayload?.jData?.pc || "CNC";
  const validity = brokerOrder?.validity || orderPayload?.validity || orderPayload?.VL || "DAY";
  const fillPrice = Number(confirmedEntryPrice || orderStreamData?.entryPrice || brokerOrder?.entryPrice || 0);

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
    brokerOrderId: brokerOrder._id
  });

  try {
    await BrokerOrder.findByIdAndUpdate(brokerOrder._id, {
      childOrdersPlaced: true,
      childOrdersPlacedAt: new Date(),
      entryPrice: fillPrice > 0 ? fillPrice : undefined,
      brokerOrderId: brokerOrder.brokerOrderId || orderStreamData?.orderId || null,
      brokerStatus: orderStreamData?.orderStatus || brokerOrder.brokerStatus,
      status: orderStreamData?.orderStatus === "COMPLETE" ? "COMPLETED" : brokerOrder.status
    });
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
  const hasTP = Number.isFinite(targetPoints) && targetPoints > 0;
  const hasSL = Number.isFinite(stopLossPoints) && stopLossPoints > 0;

  if (!hasTP && !hasSL) {
    return [];
  }

  if (!fillPrice || isNaN(fillPrice) || fillPrice <= 0) {
    console.log("⚠️ Skipping GTT/OCO because fill price is unavailable");
    return [];
  }

  const { targetPrice, stopLossPrice } = calculateChildPrices({
    action,
    fillPrice,
    targetPoints,
    stopLossPoints
  });

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
        orderType: "LMT",
        price: targetPrice,
        amFlag: false,
        gtt: true,
        oco: true,
        orderTag: "TP"
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
        orderType: "SL",
        price: stopLossPrice,
        amFlag: false,
        gtt: true,
        oco: true,
        orderTag: "SL"
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
        orderType: "LMT",
        price: targetPrice,
        amFlag: false,
        gtt: true,
        oco: false,
        orderTag: "TP"
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
        orderType: "SL",
        price: stopLossPrice,
        amFlag: false,
        gtt: true,
        oco: false,
        orderTag: "SL"
      })
    });
  }

  const childResults = [];

  for (const child of childOrders) {
    try {
      const response = await postKotakOrder(child.jData, sessionToken, sid, baseUrl);
      const responseBody = response?.data && typeof response.data === "object" ? response.data : {};
      childResults.push({
        tag: child.tag,
        status: responseBody?.status || responseBody?.stat || responseBody?.order_status || responseBody?.orderStatus || "UNKNOWN",
        response: responseBody,
        payload: child.jData
      });
    } catch (err) {
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
        : 10;
    const stopLossPointsFinal =
      Number.isFinite(stopLossPoints) && stopLossPoints > 0
        ? stopLossPoints
        : 100;

    const orderType = String(rawOrderType).trim().toUpperCase();
    const normalizedOrderType =
      orderType === "LMT" ? "LIMIT" :
      orderType === "SLM" || orderType === "SL-M" ? "SL" :
      orderType;

    const orderTypeMap = {
      MARKET: { pt: "MKT", pr: "0" },
      LIMIT: { pt: "LMT", pr: String(priceValue > 0 ? priceValue : 0) },
      SL: { pt: "SL", pr: String(priceValue > 0 ? priceValue : 0) }
    };

    if (
      ["LIMIT", "SL"].includes(normalizedOrderType) &&
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

    const orderSpec = orderTypeMap[normalizedOrderType] || orderTypeMap.MARKET;

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

      await BrokerOrder.findByIdAndUpdate(brokerOrderDoc._id, {
        brokerOrderId,
        brokerStatus,
        response: orderData,
        status: statusValue === "SUCCESS" ? "PENDING_CONFIRMATION" : statusValue,
        childOrders,
        completedAt: statusValue === "SUCCESS" ? null : new Date()
      });

      if (statusValue === "SUCCESS" && brokerOrderId && sessionToken && sid && baseUrl) {
        setTimeout(() => {
          (async () => {
            try {
              await placeGttOcoChildOrdersOnConfirmation({
                brokerOrder: await BrokerOrder.findById(brokerOrderDoc._id),
                orderStreamData: { orderId: brokerOrderId, orderStatus: "PENDING" },
                sessionToken,
                sid,
                baseUrl
              });
            } catch (retryErr) {
              console.log("⚠️ Deferred child-order retry failed:", retryErr?.message || retryErr);
            }
          })();
        }, 4000);
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
      const ltpVal = await getLTP(symbol, instrument?.es);
      tradePrice = Number(ltpVal) || 0;

      // fallback to WS/Redis cached tick if API LTP is unavailable
      if ((!tradePrice || tradePrice === 0) && getTickAsync) {
        try {
          const tickVal = await getTickAsync(symbol);
          tradePrice = Number(tickVal) || tradePrice || 0;
        } catch (_) {
          // ignore
        }
      }
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
  placeGttOcoChildOrdersOnConfirmation,
  placeGttOcoChildOrders
};