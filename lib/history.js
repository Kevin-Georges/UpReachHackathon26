const { HISTORY_MAX_POINTS, MEANINGFUL_NAV_DELTA_GBP } = require("./config");
const { roundMoneyGBP } = require("./pricing");

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function hash01FromString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return ((h >>> 0) % 10001) / 10000;
}

/**
 * Deterministic multi-day history for charts: same fundId + end NAV → same points (no Math.random).
 */
function historyAround(fundId, endPrice) {
  const n = HISTORY_MAX_POINTS;
  const safe = Number(endPrice);
  if (!Number.isFinite(safe) || safe <= 0) {
    return [{ date: todayISO(), price: roundMoneyGBP(1) }];
  }
  const raw = [];
  for (let i = 0; i < n; i += 1) {
    const wave = (hash01FromString(`${fundId}|h|${i}`) - 0.5) * 0.04;
    raw.push(safe * (1 + wave));
  }
  const lastRaw = raw[n - 1];
  const scale = Number.isFinite(lastRaw) && lastRaw !== 0 ? safe / lastRaw : 1;
  const today = new Date();
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (n - 1 - i));
    const date = d.toISOString().slice(0, 10);
    const p = i === n - 1 ? safe : roundMoneyGBP(raw[i] * scale);
    out.push({ date, price: p });
  }
  out[n - 1] = { date: out[n - 1].date, price: roundMoneyGBP(safe) };
  return out;
}

/**
 * Merge rebuilt NAV into persisted in-memory series.
 * - Empty: seed with deterministic `historyAround(fundId, newPrice)`.
 * - Same calendar day, |ΔNAV| < threshold: leave series unchanged (no fake movement on refresh).
 * - Same day, meaningful move: replace last point.
 * - New calendar day: append, trim to HISTORY_MAX_POINTS.
 */
function mergePersistedHistory(prevSeries, newPrice, fundId) {
  const prev =
    Array.isArray(prevSeries) && prevSeries.length > 0
      ? prevSeries.map((p) => ({
          date: String(p?.date || "").slice(0, 10),
          price: Number(p?.price),
        }))
      : [];

  if (prev.length === 0) {
    return historyAround(fundId, newPrice);
  }

  const today = todayISO();
  const last = prev[prev.length - 1];

  if (last.date === today) {
    const delta = Math.abs(Number(last.price) - Number(newPrice));
    if (delta < MEANINGFUL_NAV_DELTA_GBP) {
      return prev.map((p) => ({ date: p.date, price: p.price }));
    }
  }

  const series = prev.map((p) => ({ ...p }));

  if (last.date === today) {
    series[series.length - 1] = { date: today, price: newPrice };
  } else {
    series.push({ date: today, price: newPrice });
  }

  while (series.length > HISTORY_MAX_POINTS) {
    series.shift();
  }
  return series;
}

function deterministicPlaceholderNav(fundId) {
  let h = 2166136261;
  const s = String(fundId || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = h >>> 0;
  const base = 88 + (u % 620);
  const frac = (u % 100) / 100;
  return roundMoneyGBP(base + frac);
}

module.exports = {
  mergePersistedHistory,
  deterministicPlaceholderNav,
};
