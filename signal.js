const axios = require("axios");
const express = require("express");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");

const {
  getAccessToken,
  getSessionToken,
  getSid,
  getBaseUrl
} = require("./tokenManager");
const { findInstrument } = require("./instrumentStore");
const { getTickAsync, subscribeSymbols } = require("./wsService");
const Trade = require("./models/Trade");

const ltpCache = new Map();
const CACHE_MS = 1200;
let lastCallTime = 0;
let postTradeLockUntil = 0;
let lastRateLimitAt = 0;
let lastQuoteRequestAt = 0;

const MIN_GAP_MS = 1500;
const POST_TRADE_COOLDOWN = 4000;
const RATE_LIMIT_COOLDOWN_MS = 5000;
const TRAIL_GAP = 10;
const INITIAL_SL = -500;
const QUOTE_REQUEST_GAP_MS = 1000;

function normalize(symbol) {
  return (symbol || "").toString().trim().toUpperCase();
}

function formatQuoteSymbol(rawSymbol) {
  const symbol = (rawSymbol || "").toString().trim();
  if (!symbol) return symbol;
  if (symbol.includes("|")) {
    return symbol.split("|")[1];
  }
  return symbol;
}

function buildQuoteUrl(baseUrl, exchange, symbol, filter = "all") {
  const cleanExchange = String(exchange || "nse_fo").trim().toLowerCase();
  const quoteSymbol = formatQuoteSymbol(symbol);
  const encoded = encodeURIComponent(`${cleanExchange}|${quoteSymbol}`);
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/$/, "") + `/script-details/1.0/quotes/neosymbol/${encoded}/${filter}`;
  return url.toString();
}

function setPostTradeCooldown() {
  postTradeLockUntil = Date.now() + POST_TRADE_COOLDOWN;
}

function createQuoteRequestThrottler(gapMs = QUOTE_REQUEST_GAP_MS) {
  let lastRunAt = 0;

  return async function runWithThrottle(fn) {
    const now = Date.now();
    const waitTime = Math.max(0, lastRunAt + gapMs - now);
    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    lastRunAt = Date.now();
    return fn();
  };
}

const quoteRequestThrottler = createQuoteRequestThrottler();

async function safeLTPCall(fn) {
  const now = Date.now();

  if (now < postTradeLockUntil) {
    await new Promise((resolve) => setTimeout(resolve, postTradeLockUntil - now));
  }

  const diff = now - lastCallTime;
  if (diff < MIN_GAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_GAP_MS - diff));
  }

  lastCallTime = Date.now();
  return fn();
}

async function getQuote(symbol, exchangeOverride, filter = "all", retry = 1) {
  if (!symbol) return null;

  const key = normalize(symbol);
  let quoteSymbol = formatQuoteSymbol(symbol);
  const accessToken = getAccessToken();
  const sessionToken = getSessionToken();
  const sid = getSid();
  const baseUrl = getBaseUrl();

  let exchange = String(exchangeOverride || "").trim().toLowerCase();
  if (!exchange && key.includes("|")) {
    const [exchangePart] = key.split("|");
    exchange = exchangePart.toLowerCase();
  }

  if (!exchange) {
    const instrument = findInstrument(key);
    if (instrument?.es) {
      exchange = String(instrument.es).trim().toLowerCase();
    }
  }

  if (!exchange) {
    exchange = "nse_fo";
  }

  if (!baseUrl) {
    console.error("❌ Missing baseUrl");
    return null;
  }

  const url = buildQuoteUrl(baseUrl, exchange, quoteSymbol, filter);
  const headers = {
    "neo-fin-key": "neotradeapi",
    "Content-Type": "application/json"
  };

  if (sessionToken && sid) {
    headers.Auth = sessionToken;
    headers.Sid = sid;
  }

  if (accessToken) {
    headers.Authorization = accessToken;
  }

  try {
    if (Date.now() - lastRateLimitAt < RATE_LIMIT_COOLDOWN_MS) {
      return null;
    }

    const requestRunner = async () => safeLTPCall(() => axios.get(url, { headers, timeout: 8000 }));
    const res = await quoteRequestThrottler(requestRunner);
    return res?.data ?? null;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data || err.message;

    if (status === 429) {
      lastRateLimitAt = Date.now();
      console.error("🚨 Quote rate limited 429");
      return null;
    }

    if (typeof msg === "string" && msg.includes("too many")) {
      console.error("🚨 Quotes THROTTLED BY KOTAK");
    } else {
      console.error("❌ Quote Error:", msg);
    }

    if (retry > 0) {
      return getQuote(symbol, exchangeOverride, filter, retry - 1);
    }

    return null;
  }
}

async function getLTP(symbol, exchangeOverride, retry = 1) {
  if (!symbol) return 0;

  const key = normalize(symbol);
  const now = Date.now();

  const cached = ltpCache.get(key);
  if (cached && now - cached.time < CACHE_MS) {
    return cached.value;
  }

  try {
    const wsLtp = await getTickAsync(key);
    if (wsLtp && wsLtp > 0) {
      ltpCache.set(key, { value: wsLtp, time: Date.now() });
      return wsLtp;
    }
  } catch (_) {
    // ignore websocket cache failures
  }

  try {
    const instrument = findInstrument(key);
    const subscriptionSymbols = [key];
    if (instrument?.ts && instrument.ts !== key) {
      subscriptionSymbols.push(instrument.ts);
    }
    if (instrument?.token && instrument.token !== key) {
      subscriptionSymbols.push(instrument.token);
    }
    await subscribeSymbols(subscriptionSymbols);
  } catch (_) {
    // ignore subscription failures
  }

  const data = await getQuote(symbol, exchangeOverride, "ltp", retry);
  let raw = 0;

  if (Array.isArray(data) && data.length > 0) {
    raw = data[0]?.ltp ?? data[0]?.lastPrice ?? 0;
  } else if (data && typeof data === "object") {
    raw = data?.ltp ?? data?.lastPrice ?? 0;
  }

  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? parsed : 0;

  ltpCache.set(key, { value, time: Date.now() });
  return value;
}

async function calculatePnL(positionsInput = null) {
  try {
    const { getPositions } = require("./positionService");
    const positions = positionsInput ?? (await getPositions());

    if (!Array.isArray(positions) || positions.length === 0) {
      return { totalPnL: 0, positions: [] };
    }

    let totalPnL = 0;
    const enriched = [];
    const ltpPromises = positions.map(async (p) => {
      try {
        let ltpRaw = p?.ltp;
        let ltp = Number(ltpRaw);

        if (!Number.isFinite(ltp) || ltp <= 0) {
          const fetched = await getLTP(p?.instrument || p?.ts || p?.symbol);
          ltp = Number(fetched);
        }

        if (!Number.isFinite(ltp) || ltp < 0) ltp = 0;
        return ltp;
      } catch {
        return 0;
      }
    });

    const ltps = await Promise.all(ltpPromises);

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const ltp = ltps[i] ?? 0;
      const qty = Number(p?.netQty) || 0;
      const buy = Number(p?.buyAvg) || 0;
      const sell = Number(p?.sellAvg) || 0;

      let pnl = 0;
      const existingPnL = Number(p?.pnl);

      if (Number.isFinite(existingPnL)) {
        pnl = existingPnL;
      } else if (qty > 0 && buy > 0 && ltp > 0) {
        pnl = (ltp - buy) * qty;
      } else if (qty < 0 && sell > 0 && ltp > 0) {
        pnl = (sell - ltp) * Math.abs(qty);
      } else {
        pnl = 0;
      }

      pnl = Number.isFinite(pnl) ? pnl : 0;
      totalPnL += pnl;
      enriched.push({ ...p, ltp, livePnL: pnl });
    }

    totalPnL = Number.isFinite(totalPnL) ? totalPnL : 0;
    return { totalPnL, positions: enriched };
  } catch (err) {
    console.error("❌ PnL Error:", err?.message || err);
    return { totalPnL: 0, positions: [] };
  }
}

async function placeOrder(order, signalId = null) {
  const override = module.exports?.placeOrder;
  if (typeof override === "function" && override !== placeOrder) {
    return override(order, signalId);
  }

  const { placeOrder: placeBrokerOrder } = require("./orderService");
  return placeBrokerOrder(order, signalId);
}

async function monitorTrades() {
  try {
    if (mongoose.connection.readyState !== 1) {
      return;
    }

    const openTrades = await Trade.find({ status: "OPEN" });

    if (!openTrades.length) return;

    for (const t of openTrades) {
      try {
        const ltp = await getLTP(t.instrument);

        if (!ltp || Number.isNaN(ltp)) continue;

        const freshTrade = await Trade.findOne({ _id: t._id, status: "OPEN" });
        if (!freshTrade) continue;

        // No risk-based exit anymore. This function now only serves as a placeholder for open-trade monitoring.
        if (freshTrade && freshTrade._closing) continue;
      } catch (err) {
        console.error(`❌ Trade error (${t.instrument}):`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ monitorTrades Error:", err.message);
  }
}

async function squareOffAll() {
  try {
    if (mongoose.connection.readyState !== 1) {
      return;
    }

    const openTrades = await Trade.find({ status: "OPEN" });
    if (!openTrades.length) return;

    for (const t of openTrades) {
      try {
        const freshTrade = await Trade.findOne({ _id: t._id, status: "OPEN" });
        if (!freshTrade) continue;

        const exitSide = t.side === "BUY" ? "SELL" : "BUY";
        const exitPrice = Number(t.targetPrice || t.price || 0);
        const orderRes = await placeOrder({ TS: t.instrument, quantity: t.quantity, transaction_type: exitSide, order_type: exitPrice > 0 ? "LIMIT" : "MARKET", price: exitPrice > 0 ? exitPrice : undefined, product: "NRML" });

        if (orderRes && orderRes.status === "REJECTED") {
          continue;
        }

        freshTrade.status = "CLOSED";
        freshTrade.exitTime = new Date();
        await freshTrade.save();
      } catch (err) {
        console.error(`❌ Square-off failed (${t.instrument}):`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ squareOffAll Error:", err.message);
  }
}

async function monitorTargets() {
  try {
    const trades = await Trade.find({ status: "OPEN" });

    for (const trade of trades) {
      try {
        const symbol = trade.instrument || trade.symbol;
        if (!symbol) continue;

        const ltp = await getLTP(symbol);
        if (!ltp) continue;

        if (trade.side === "BUY" && trade.targetPrice && ltp >= trade.targetPrice) {
          const orderRes = await placeOrder({ TS: symbol, quantity: trade.quantity, transaction_type: "SELL", order_type: "LIMIT", price: trade.targetPrice, product: "NRML" });
          if (!orderRes) continue;

          trade.status = "CLOSED";
          trade.closeReason = "TARGET_HIT";
          trade.exitPrice = ltp;
          trade.exitTime = new Date();
          trade.pnl = (ltp - Number(trade.entryPrice || trade.price || 0)) * trade.quantity;
          await trade.save();
        }

        if (trade.side === "SELL" && trade.targetPrice && ltp <= trade.targetPrice) {
          const orderRes = await placeOrder({ TS: symbol, quantity: trade.quantity, transaction_type: "BUY", order_type: "LIMIT", price: trade.targetPrice, product: "NRML" });
          if (!orderRes) continue;

          trade.status = "CLOSED";
          trade.closeReason = "TARGET_HIT";
          trade.exitPrice = ltp;
          trade.exitTime = new Date();
          trade.pnl = (Number(trade.entryPrice || trade.price || 0) - ltp) * trade.quantity;
          await trade.save();
        }
      } catch (err) {
        console.error(`Target trade error: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`Monitor target error: ${err.message}`);
  }
}

async function monitorTrailingSL() {
  try {
    if (mongoose.connection.readyState !== 1) return;

    const openTrades = await Trade.find({ status: "OPEN", useTrailingSL: true });
    if (!openTrades.length) return;

    for (const t of openTrades) {
      try {
        const ltp = await getLTP(t.instrument);
        if (!ltp || Number.isNaN(ltp) || !t.price || !t.quantity) continue;

        let updated = false;

        if (t.highestPrice == null) {
          t.highestPrice = t.price;
          updated = true;
        }

        if (t.side === "SELL" && t.lowestPrice == null) {
          t.lowestPrice = t.price;
          updated = true;
        }

        if (t.trailingSL == null) {
          t.trailingSL = t.side === "BUY" ? t.price + INITIAL_SL : t.price - INITIAL_SL;
          updated = true;
        }

        if (t.side === "BUY") {
          if (ltp > t.highestPrice) {
            t.highestPrice = ltp;
            const newSL = ltp - TRAIL_GAP;
            if (!t.trailingSL || newSL > t.trailingSL) {
              t.trailingSL = newSL;
              updated = true;
            }
          }
        } else if (t.side === "SELL") {
          if (ltp < t.lowestPrice) {
            t.lowestPrice = ltp;
            const newSL = ltp + TRAIL_GAP;
            if (!t.trailingSL || newSL < t.trailingSL) {
              t.trailingSL = newSL;
              updated = true;
            }
          }
        }

        const slHit = (t.side === "BUY" && ltp <= t.trailingSL) || (t.side === "SELL" && ltp >= t.trailingSL);
        if (!slHit) {
          if (updated) await t.save();
          continue;
        }

        const exitSide = t.side === "BUY" ? "SELL" : "BUY";
        const exitPrice = Number(t.trailingSL || t.price || 0);
        await placeOrder({ TS: t.instrument, quantity: t.quantity, transaction_type: exitSide, order_type: exitPrice > 0 ? "LIMIT" : "MARKET", price: exitPrice > 0 ? exitPrice : undefined, product: "NRML" });

        t.status = "CLOSED";
        t.exitPrice = ltp;
        t.exitTime = new Date();
        t.pnl = t.side === "BUY" ? (ltp - t.price) * t.quantity : (t.price - ltp) * t.quantity;
        await t.save();
      } catch (err) {
        console.error(`❌ Trailing SL Error (${t.instrument}):`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ monitorTrailingSL Error:", err.message);
  }
}

async function runSignalLoop() {
  await monitorTrailingSL();
  await monitorTargets();
  await monitorTrades();
  return calculatePnL();
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests"
});

function createSignalEngine({ port = 3000, quoteFetcher = getLTP } = {}) {
  const app = express();
  app.use(express.json());

  const stateFile = path.join(__dirname, "positions_state.json");
  let positions = {};

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, "utf-8");
        const data = JSON.parse(raw || "{}");
        positions = data && typeof data === "object" ? data : {};
      }
    } catch (err) {
      console.error("❌ Failed to load state:", err.message);
      positions = {};
    }
  }

  function saveState() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(positions, null, 2));
    } catch (err) {
      console.error("❌ Failed to save state:", err.message);
    }
  }

  async function placeMarketOrder({ symbol, qty, side }) {
    const price = await quoteFetcher(symbol);
    return { avgPrice: price, status: "SUCCESS" };
  }

  app.post("/webhook", async (req, res) => {
    try {
      const { action, symbol, qty, target_points, sl_points, TSL } = req.body;
      if (!symbol || !qty || !action) {
        return res.status(400).send({ status: "invalid request" });
      }

      if (positions[symbol]) {
        return res.send({ status: "already open" });
      }

      const order = await placeMarketOrder({ symbol, qty, side: action });
      if (!order || !order.avgPrice) {
        return res.status(500).send({ status: "order failed" });
      }

      const entryPrice = Number(order.avgPrice);
      const target = action === "BUY" ? entryPrice + Number(target_points || 0) : entryPrice - Number(target_points || 0);
      const sl = action === "BUY" ? entryPrice - Number(sl_points || 5) : entryPrice + Number(sl_points || 5);
      const useTrailingSL = Boolean(TSL && String(TSL).trim().toLowerCase() !== "false");

      positions[symbol] = { entryPrice, qty, target, sl, side: action, _closing: false, useTrailingSL };
      saveState();

      if (mongoose.connection.readyState === 1) {
        try {
          await Trade.create({
            broker: "KOTAK",
            side: action,
            quantity: Number(qty),
            instrument: symbol,
            orderId: "WEBHOOK",
            price: entryPrice,
            entryPrice,
            targetPrice: target,
            stopLossPrice: sl,
            status: "OPEN",
            time: new Date(),
            highestPrice: entryPrice,
            trailingSL: useTrailingSL ? (action === "BUY" ? entryPrice - INITIAL_SL : entryPrice + INITIAL_SL) : 0,
            useTrailingSL
          });
        } catch (dbErr) {
          console.error("Webhook trade save failed:", dbErr.message);
        }
      }

      res.send({ status: "ok", entryPrice, target, sl, useTrailingSL });
    } catch (err) {
      console.error("Webhook error:", err.message);
      res.status(500).send({ status: "error" });
    }
  });

  loadState();
  const server = app.listen(port, () => {
    console.log(`🚀 Signal engine listening on port ${port}`);
  });

  return { app, server, positions, stop: () => server.close() };
}

function startSignalEngine(options = {}) {
  return createSignalEngine(options);
}

module.exports = {
  apiLimiter,
  createQuoteRequestThrottler,
  getLTP,
  getQuote,
  setPostTradeCooldown,
  calculatePnL,
  monitorTrades,
  squareOffAll,
  monitorTargets,
  monitorTrailingSL,
  runSignalLoop,
  createSignalEngine,
  startSignalEngine
};
