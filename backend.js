/**
 * Backend: index-fund JSON for frontend.html using TCG API (https://tcgapi.dev/)
 * Dashboard / API keys: https://tcgapi.dev/dashboard/
 *
 * Prices: With TCGAPI_KEY, live TCG API data. Without a key, the API serves stable deterministic placeholder
 *         funds (fixed NAV per fund id, 0% daily change) so the UI still loads.
 *
 * Baskets: After the first successful search, each fund locks card IDs and each card’s weight % (share of
 *          the basket at lock time). Refresh fetches fresh prices only; weight % columns stay fixed so the
 *          table does not “reshuffle” on every rebuild. Index NAV = sum(price_i × weight_i / 100).
 *
 * History: In-memory per session. Seeded with a deterministic curve from `historyAround(fundId, nav)` (no
 *          Math.random). Merges across refreshes: new calendar day or meaningful NAV move updates the
 *          series; trivial API jitter leaves the last point unchanged. Max 30 points.
 *
 * dayChangePct: (currentNav - lastPublishedNav) / lastPublishedNav × 100 from an in-memory map, not from
 *               synthetic history. First observation per fund → 0. Placeholder funds always 0%.
 *
 * Three game indices: Pokemon, Magic: The Gathering, Yu-Gi-Oh! (TCG API search baskets).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");

const TCGAPI = "https://api.tcgapi.dev/v1";
const PORT = Number(process.env.PORT) || 3847;
const USD_TO_GBP = 0.79;
const API_KEY =
  process.env.TCGAPI_KEY || process.env.TCGAPI_DEV_KEY || process.env.X_API_KEY || "";

/** Longer cache to stay within TCG API daily limits (free tier). */
const CACHE_MS = 60 * 60 * 1000;

const FUND_META = [
  {
    id: "pokemon",
    name: "Pokemon Index",
    type: "game",
    gameKey: "pokemon",
    description: "Pokemon TCG basket from TCG API search (market prices, USD→GBP).",
  },
  {
    id: "mtg",
    name: "Magic: The Gathering Index",
    type: "game",
    gameKey: "mtg",
    description: "MTG basket from TCG API search (market prices, USD→GBP).",
  },
  {
    id: "ygo",
    name: "Yu-Gi-Oh! Index",
    type: "game",
    gameKey: "ygo",
    description: "Yu-Gi-Oh! basket from TCG API search (market prices, USD→GBP).",
  },
];

function tcgapiHeaders() {
  const h = { Accept: "application/json" };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...tcgapiHeaders(), ...opts.headers } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TCG API HTTP ${res.status}: ${t.slice(0, 240)}`);
  }
  return res.json();
}

let gamesListCache = null;

async function listAllGames() {
  if (gamesListCache) return gamesListCache;
  const all = [];
  let page = 1;
  for (;;) {
    const j = await fetchJson(`${TCGAPI}/games?page=${page}&per_page=100`);
    all.push(...(j.data || []));
    if (!j.meta?.has_more) break;
    page += 1;
    if (page > 20) break;
  }
  gamesListCache = all;
  return all;
}

function slugForGame(games, patterns) {
  for (const re of patterns) {
    const g = games.find((x) => re.test(x.name));
    if (g?.slug) return g.slug;
  }
  return null;
}

/** Resolve API `game=` slugs (public /v1/games) with string fallbacks. */
function resolveGameSlugs(games) {
  return {
    pokemon: slugForGame(games, [/^Pokemon$/i, /Pokemon/i]) || "pokemon",
    mtg:
      slugForGame(games, [/Magic:\s*The Gathering/i, /^Magic: The Gathering$/i, /Magic.*Gathering/i]) ||
      "magic-the-gathering",
    ygo: slugForGame(games, [/Yu-Gi-Oh/i]) || "yu-gi-oh",
  };
}

/**
 * @param {Record<string, string|number|undefined>} params
 */
async function tcgSearch(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") sp.set(k, String(v));
  }
  return fetchJson(`${TCGAPI}/search?${sp.toString()}`);
}

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

const HISTORY_MAX_POINTS = 30;

/** Same-day NAV updates below this (GBP) do not rewrite the last history point (stable chart on refresh). */
const MEANINGFUL_NAV_DELTA_GBP = 0.02;

/**
 * Per fund: locked TCG card ids (order) + frozen weight % from discovery (sum ~100).
 * Refresh updates prices only; weights stay fixed.
 */
const lockedBasketByFundId = new Map();
const LOCK_BASKET_SIZE = 42;
const MIN_LOCKED_REFRESH_PRICES = 3;

/** Last published NAV per fund (live API only); used for dayChangePct, not derived from history. */
const lastPublishedNavByFundId = new Map();

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

/**
 * Build client constituents using frozen weights; only priceGBP comes from latest API data.
 */
function buildConstituentsFrozen(cards, snap) {
  if (!snap?.ids?.length || !snap?.weightPct?.length || snap.ids.length !== snap.weightPct.length) {
    return [];
  }
  const byId = new Map();
  for (const c of cards) {
    const id = Number(c.id);
    if (Number.isFinite(id)) byId.set(id, c);
  }
  const out = [];
  for (let i = 0; i < snap.ids.length; i += 1) {
    const raw = byId.get(snap.ids[i]);
    if (!raw) continue;
    const n = normalizeCard(raw);
    const { _usd, _dedupe, ...rest } = n;
    out.push({
      name: rest.name,
      number: rest.number,
      setName: rest.setName,
      rarity: rest.rarity,
      priceGBP: roundMoneyGBP(rest.priceGBP),
      contribution: snap.weightPct[i],
    });
  }
  return out;
}

async function fetchCardRecordById(cardId) {
  const j = await fetchJson(`${TCGAPI}/cards/${encodeURIComponent(cardId)}`);
  return j.data || null;
}

function searchPlansForFund(meta, gameSlug) {
  const game = gameSlug;
  switch (meta.gameKey) {
    case "pokemon":
      return [
        { q: "charizard", game, sort: "price_desc", per_page: 14 },
        { q: "blastoise", game, sort: "price_desc", per_page: 14 },
        { q: "venusaur", game, sort: "price_desc", per_page: 14 },
      ];
    case "mtg":
      return [
        { q: "lightning bolt", game, sort: "price_desc", per_page: 14 },
        { q: "black lotus", game, sort: "price_desc", per_page: 14 },
        { q: "counterspell", game, sort: "price_desc", per_page: 14 },
      ];
    case "ygo":
      return [
        { q: "dark magician", game, sort: "price_desc", per_page: 14 },
        { q: "blue eyes", game, sort: "price_desc", per_page: 14 },
        { q: "exodia", game, sort: "price_desc", per_page: 14 },
      ];
    default:
      return [];
  }
}

async function discoverCardsViaSearch(meta, gameSlug) {
  const all = [];
  for (const params of searchPlansForFund(meta, gameSlug)) {
    try {
      const data = await tcgSearch(params);
      for (const c of data.data || []) all.push(c);
    } catch (e) {
      console.warn(`[tcgapi] search ${JSON.stringify(params)}: ${e.message}`);
    }
  }
  return all;
}

/**
 * First run: search and lock card IDs. Later runs: same IDs, GET /cards/:id for fresh prices only.
 */
async function loadCardsForFund(meta, gameSlug) {
  if (!API_KEY) return [];
  if (!gameSlug) {
    console.warn(`[tcgapi] missing game slug for fund ${meta.id}`);
    return [];
  }

  const fundId = meta.id;
  const basket = lockedBasketByFundId.get(fundId);

  if (basket?.ids?.length > 0) {
    const cards = [];
    for (const cid of basket.ids) {
      try {
        const c = await fetchCardRecordById(cid);
        if (c) cards.push(c);
      } catch (e) {
        console.warn(`[tcgapi] cards/${cid}: ${e.message}`);
      }
    }
    const priced = cards.filter((c) => usdFromTcgApiCard(c) > 0).length;
    if (priced >= MIN_LOCKED_REFRESH_PRICES) {
      return cards;
    }
    console.warn(`[tcgapi] ${fundId}: locked basket returned too few prices — running discovery again`);
    lockedBasketByFundId.delete(fundId);
  }

  const all = await discoverCardsViaSearch(meta, gameSlug);
  const seen = new Set();
  const picked = [];
  for (const c of all) {
    const id = c.id;
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    if (usdFromTcgApiCard(c) <= 0) continue;
    seen.add(key);
    picked.push(c);
    if (picked.length >= LOCK_BASKET_SIZE) break;
  }

  if (picked.length === 0) return [];

  const norms = picked.map((c) => normalizeCard(c));
  const total = norms.reduce((s, n) => s + n.priceGBP, 0) || 1;
  const weightPct = norms.map((n) => (n.priceGBP / total) * 100);

  lockedBasketByFundId.set(fundId, {
    ids: picked.map((c) => Number(c.id)),
    weightPct,
  });
  return picked;
}

let cache = { at: 0, funds: null, lastUpdated: null };
let warnedNoKey = false;

function snapshotPrevFundsById() {
  const prevById = new Map();
  if (Array.isArray(cache.funds)) {
    for (const f of cache.funds) {
      if (!f?.id) continue;
      prevById.set(f.id, {
        priceGBP: f.priceGBP,
        history: Array.isArray(f._history) ? f._history.map((p) => ({ ...p })) : [],
      });
    }
  }
  return prevById;
}

function buildPlaceholderFundSummaries() {
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn(
      "Set TCGAPI_KEY from https://tcgapi.dev/dashboard/ for live TCG API prices (placeholder mode until then)."
    );
  }
  const prevById = snapshotPrevFundsById();
  const funds = [];
  for (const meta of FUND_META) {
    const nav = deterministicPlaceholderNav(meta.id);
    const prev = prevById.get(meta.id);
    const dayChangePct = 0;
    const history = mergePersistedHistory(prev?.history, nav, meta.id);
    funds.push({
      id: meta.id,
      name: meta.name,
      type: meta.type,
      priceGBP: nav,
      dayChangePct,
      description: `${meta.description} (placeholder — set TCGAPI_KEY for live data.)`,
      _constituents: [],
      _history: history,
    });
  }
  return funds;
}

async function buildFundSummaries() {
  if (!API_KEY) {
    return buildPlaceholderFundSummaries();
  }

  const prevById = snapshotPrevFundsById();

  let games = [];
  try {
    games = await listAllGames();
  } catch (e) {
    console.warn(`[tcgapi] could not list games: ${e.message}`);
  }
  const gameSlugs = resolveGameSlugs(games);

  const funds = [];
  for (const meta of FUND_META) {
    let cards = [];
    try {
      cards = await loadCardsForFund(meta, gameSlugs[meta.gameKey]);
    } catch (e) {
      console.warn(`[tcgapi] ${meta.id}: ${e.message}`);
    }

    const snap = lockedBasketByFundId.get(meta.id);
    let constituents = [];
    if (snap?.ids?.length) {
      constituents = buildConstituentsFrozen(cards, snap);
    }
    if (constituents.length === 0) {
      constituents = buildConstituents(cards);
    }
    if (constituents.length === 0) {
      console.warn(`[tcgapi] ${meta.id}: no priced cards from API — fund omitted`);
      continue;
    }

    let nav = constituents.reduce((s, c) => s + (c.priceGBP * c.contribution) / 100, 0);
    if (!Number.isFinite(nav) || nav <= 0) {
      nav =
        constituents.reduce((s, c) => s + c.priceGBP, 0) / Math.max(constituents.length, 1) || 100;
    }
    nav = roundMoneyGBP(nav);

    const prev = prevById.get(meta.id);
    const prevPublished = lastPublishedNavByFundId.get(meta.id);
    const prevPrice = Number(prevPublished);
    let dayChangePct = 0;
    if (Number.isFinite(prevPrice) && prevPrice > 0) {
      dayChangePct = ((nav - prevPrice) / prevPrice) * 100;
    }

    const history = mergePersistedHistory(prev?.history, nav, meta.id);

    funds.push({
      id: meta.id,
      name: meta.name,
      type: meta.type,
      priceGBP: nav,
      dayChangePct,
      description: meta.description,
      _constituents: constituents,
      _history: history,
    });
    lastPublishedNavByFundId.set(meta.id, nav);
  }
  return funds;
}

async function ensureFundsLoaded() {
  if (!cache.funds) await getFundsPayload(true);
}

function stripFundForClient(f) {
  const { _constituents, _history, ...rest } = f;
  return rest;
}

async function getFundsPayload(force) {
  const now = Date.now();
  if (!force && cache.funds && now - cache.at < CACHE_MS) {
    return {
      funds: cache.funds.map(stripFundForClient),
      lastUpdated: cache.lastUpdated,
    };
  }
  const built = await buildFundSummaries();
  if (built.length === 0) {
    throw new Error(
      "No funds available: set TCGAPI_KEY in .env, run the backend with network access, and ensure TCG API search returns cards (see server logs)."
    );
  }
  const lastUpdated = Date.now();
  cache = { at: now, funds: built, lastUpdated };
  return {
    funds: built.map(stripFundForClient),
    lastUpdated,
  };
}

function getFundDetail(id) {
  const f = cache.funds?.find((x) => x.id === id);
  if (!f) return null;
  const constituents = f._constituents || [];
  const history = f._history || [];
  const nav =
    constituents.reduce((s, c) => s + (c.priceGBP * c.contribution) / 100, 0) ||
    f.priceGBP;
  const { _constituents, _history, ...summary } = f;
  return {
    fund: {
      ...summary,
      priceGBP: nav,
      constituents,
      history,
    },
    lastUpdated: cache.lastUpdated,
  };
}

const INITIAL_CASH = 10_000;
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

async function main() {
  try {
    await getFundsPayload(true);
  } catch (e) {
    console.warn("Initial /api/funds build failed; first request will retry:", e.message);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname)));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "frontend.html"));
  });

  app.get("/api/funds", async (req, res) => {
    try {
      const force = req.query.refresh === "1";
      const data = await getFundsPayload(force);
      res.json(data);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get("/api/funds/:id", async (req, res) => {
    try {
      await ensureFundsLoaded();
      const detail = getFundDetail(req.params.id);
      if (!detail) return res.status(404).json({ error: "Fund not found" });
      res.json(detail);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get("/api/portfolio", (_req, res) => {
    res.json(computePortfolio());
  });

  app.post("/api/portfolio/:type", async (req, res) => {
    const type = String(req.params.type || "").toLowerCase();
    const { fundId, amountGBP } = req.body || {};
    if (!fundId || amountGBP == null) {
      return res.status(400).json({ error: "fundId and amountGBP required" });
    }
    try {
      await ensureFundsLoaded();
      const data = trade(type, fundId, Number(amountGBP));
      res.json(data);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message || "Trade failed" });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Backend http://127.0.0.1:${PORT}/  (TCG API https://tcgapi.dev/ + /api)`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
