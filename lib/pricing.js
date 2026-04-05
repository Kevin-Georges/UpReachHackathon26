const { USD_TO_GBP } = require("./config");

function usdFromTcgApiCard(card) {
  if (!card || typeof card !== "object") return 0;
  const top = card.market_price ?? card.median_price ?? card.low_price;
  const n = Number(top);
  if (Number.isFinite(n) && n > 0) return n;
  const prices = card.prices;
  if (Array.isArray(prices)) {
    for (const p of prices) {
      const v = Number(p?.market_price ?? p?.median_price ?? p?.low_price);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return 0;
}

function roundMoneyGBP(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeCard(card) {
  const usd = usdFromTcgApiCard(card);
  const priceGBP = Math.max(0.5, usd * USD_TO_GBP);
  return {
    name: String(card.name || "Unknown"),
    number: String(card.number ?? "?"),
    setName: String(card.set_name || "—"),
    rarity: String(card.rarity || "—"),
    priceGBP,
    _usd: usd,
    _dedupe: String(card.id ?? `${card.name}-${card.number}-${card.set_name}`),
  };
}

function buildConstituents(rawCards) {
  const seen = new Set();
  const list = [];
  for (const c of rawCards) {
    const n = normalizeCard(c);
    if (seen.has(n._dedupe)) continue;
    seen.add(n._dedupe);
    if (n._usd <= 0 && rawCards.length < 8) continue;
    list.push(n);
  }
  const priced = list.filter((x) => x.priceGBP > 0);
  const use = (priced.length ? priced : list).slice(0, 60);
  const total = use.reduce((s, x) => s + x.priceGBP, 0) || 1;
  return use.map((x) => {
    const contribution = (x.priceGBP / total) * 100;
    const { _usd, _dedupe, ...rest } = x;
    return { ...rest, contribution };
  });
}

module.exports = {
  usdFromTcgApiCard,
  roundMoneyGBP,
  normalizeCard,
  buildConstituents,
};
