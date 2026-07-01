const mongoose = require("mongoose");

const brokerOrderSchema = new mongoose.Schema(
  {
    signalId: { type: mongoose.Schema.Types.ObjectId, ref: "Signal", default: null },
    symbol: String,
    side: String,
    quantity: Number,
    product: String,
    orderType: String,
    validity: String,
    amo: String,
    targetPrice: Number,
    stopLossPoint: Number,
    requestPayload: { type: mongoose.Schema.Types.Mixed },
    childOrders: [{ type: mongoose.Schema.Types.Mixed }],
    brokerOrderId: String,
    entryPrice: Number,
    childOrdersPlaced: { type: Boolean, default: false },
    childOrdersPlacedAt: Date,
    childOrdersPlacementTriggered: { type: Boolean, default: false },
    childOrdersPlacementTriggeredAt: Date,
    status: { type: String, default: "PENDING" },
    brokerStatus: String,
    response: { type: mongoose.Schema.Types.Mixed },
    error: String,
    placedAt: Date,
    completedAt: Date
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("BrokerOrder", brokerOrderSchema);
