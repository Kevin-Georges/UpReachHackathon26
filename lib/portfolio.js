const { INITIAL_CASH } = require("./config");
const { getFundDetail } = require("./funds");

let portfolio = {
  cashGBP: INITIAL_CASH,
  netInvestedGBP: 0,
  positions: new Map(),
  transactions: [],
};

function fundPrice(fundId) {
  const d = getFundDetail(fundId);
  return d ? Number(d.fund.priceGBP) || 0 : 0;
}

function fundName(fundId) {
  const d = getFundDetail(fundId);
  return d?.fund?.name || fundId;
}

function computePortfolio() {
  let holdingsValueGBP = 0;
  const positions = [];
  for (const [fundId, pos] of portfolio.positions) {
    const price = fundPrice(fundId);
    const marketValueGBP = pos.units * price;
    holdingsValueGBP += marketValueGBP;
    positions.push({
      fundName: fundName(fundId),
      units: pos.units,
      priceGBP: price,
      marketValueGBP,
    });
  }
  const totalValueGBP = portfolio.cashGBP + holdingsValueGBP;
  const pnlGBP = totalValueGBP - INITIAL_CASH;
  const pnlPct = INITIAL_CASH > 0 ? (pnlGBP / INITIAL_CASH) * 100 : 0;
  return {
    cashGBP: portfolio.cashGBP,
    holdingsValueGBP,
    totalValueGBP,
    netInvestedGBP: portfolio.netInvestedGBP,
    pnlGBP,
    pnlPct,
    positions,
    transactions: [...portfolio.transactions].reverse(),
  };
}

function trade(type, fundId, amountGBP) {
  const price = fundPrice(fundId);
  if (!price || price <= 0) throw new Error("Unknown fund or price unavailable");
  const name = fundName(fundId);
  const time = new Date().toISOString();

  if (type === "buy") {
    if (amountGBP <= 0 || amountGBP > portfolio.cashGBP) {
      const err = new Error(
        amountGBP > portfolio.cashGBP ? "Insufficient cash" : "Invalid amount"
      );
      err.status = 400;
      throw err;
    }
    const units = amountGBP / price;
    portfolio.cashGBP -= amountGBP;
    portfolio.netInvestedGBP += amountGBP;
    const prev = portfolio.positions.get(fundId) || { units: 0 };
    portfolio.positions.set(fundId, { units: prev.units + units });
    portfolio.transactions.push({
      time,
      type: "BUY",
      fundName: name,
      amountGBP,
      units,
      priceAtTrade: price,
    });
    return computePortfolio();
  }

  if (type === "sell") {
    const pos = portfolio.positions.get(fundId);
    if (!pos || pos.units <= 0) {
      const err = new Error("No position in this fund");
      err.status = 400;
      throw err;
    }
    const maxValue = pos.units * price;
    const sellAmount = Math.min(amountGBP, maxValue);
    if (sellAmount <= 0) {
      const err = new Error("Invalid amount");
      err.status = 400;
      throw err;
    }
    const units = sellAmount / price;
    portfolio.cashGBP += sellAmount;
    portfolio.netInvestedGBP -= sellAmount;
    const nextUnits = pos.units - units;
    if (nextUnits < 1e-9) portfolio.positions.delete(fundId);
    else portfolio.positions.set(fundId, { units: nextUnits });
    portfolio.transactions.push({
      time,
      type: "SELL",
      fundName: name,
      amountGBP: sellAmount,
      units,
      priceAtTrade: price,
    });
    return computePortfolio();
  }

  const err = new Error("Invalid trade type");
  err.status = 400;
  throw err;
}

module.exports = {
  computePortfolio,
  trade,
};
