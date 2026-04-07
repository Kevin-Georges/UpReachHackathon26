const {
  API_KEY,
  CACHE_MS,
  FUND_META,
  LOCK_BASKET_SIZE,
  MIN_LOCKED_REFRESH_PRICES,
} = require("./config");
const {
  listAllGames,
  resolveGameSlugs,
  tcgSearch,
  fetchCardRecordById,
} = require("./tcgClient");
const {
  usdFromTcgApiCard,
  roundMoneyGBP,
  normalizeCard,
  buildConstituents,
} = require("./pricing");
const { mergePersistedHistory, deterministicPlaceholderNav } = require("./history");

/**
 * Per fund: locked TCG card ids (order) + frozen weight % from discovery (sum ~100).
 * Refresh updates prices only; weights stay fixed.
 */
const lockedBasketByFundId = new Map();

/** Last published NAV per fund (live API only); used for dayChangePct, not derived from history. */
const lastPublishedNavByFundId = new Map();

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

async function ensureFundsLoaded() {
  if (!cache.funds) await getFundsPayload(true);
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

module.exports = {
  getFundsPayload,
  ensureFundsLoaded,
  getFundDetail,
};
