const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const {
  getDailyFundSnapshots,
  getFundHistory,
  getHistoryDbStatus,
  getLatestFundSnapshots,
  upsertDailyFundSnapshots,
} = require("./database");

function loadLocalEnvFile(envFilePath = path.join(__dirname, ".env")) {
  if (!fs.existsSync(envFilePath)) return;

  try {
    const raw = fs.readFileSync(envFilePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (_err) {
    // Ignore .env parsing errors so the app can still boot with defaults.
  }
}

loadLocalEnvFile();

const PORT = process.env.PORT || 3000;
const HOST = "127.0.0.1";
const FRONTEND_PATH = path.join(__dirname, "frontend.html");

const POKEPRICE_API_KEY =
  process.env.POKEPRICE_API_KEY ||
  "pokeprice_free_e588a0d924dae302c219d9a6ed39b947acfff72e41039dcc";

const TCG_BASE_URL =
  process.env.POKEPRICE_BASE_URL || "https://www.pokemonpricetracker.com/api/v2";
const CACHE_TTL_MS = 15 * 60 * 1000;
const DISK_CACHE_FILE = path.join(__dirname, "etf-funds-cache.json");
const DISK_CACHE_MAX_AGE_HOURS_RAW = Number(process.env.DISK_CACHE_MAX_AGE_HOURS);
const DISK_CACHE_MAX_AGE_HOURS = Number.isFinite(DISK_CACHE_MAX_AGE_HOURS_RAW)
  ? Math.max(1, Math.floor(DISK_CACHE_MAX_AGE_HOURS_RAW))
  : 24;
const ETF_BASE_NAV = 100;
const API_DEFAULT_LANGUAGE = "english";
const API_PAGE_LIMIT_WITH_HISTORY = 100;
const API_HISTORY_DAYS_RAW = Number(process.env.API_HISTORY_DAYS);
const API_HISTORY_DAYS = Number.isFinite(API_HISTORY_DAYS_RAW)
  ? Math.max(1, Math.min(30, Math.floor(API_HISTORY_DAYS_RAW)))
  : 3;
const ETF_CARDS_PER_SET_RAW = Number(process.env.ETF_CARDS_PER_SET);
const ETF_CARDS_PER_SET = Number.isFinite(ETF_CARDS_PER_SET_RAW)
  ? Math.max(1, Math.min(30, Math.floor(ETF_CARDS_PER_SET_RAW)))
  : 1;
const BROAD_FUND_EXTRA_CARDS_RAW = Number(process.env.BROAD_FUND_EXTRA_CARDS);
const BROAD_FUND_EXTRA_CARDS = Number.isFinite(BROAD_FUND_EXTRA_CARDS_RAW)
  ? Math.max(0, Math.floor(BROAD_FUND_EXTRA_CARDS_RAW))
  : 20;
const ERA_FUND_EXTRA_CARDS_RAW = Number(process.env.ERA_FUND_EXTRA_CARDS);
const ERA_FUND_EXTRA_CARDS = Number.isFinite(ERA_FUND_EXTRA_CARDS_RAW)
  ? Math.max(0, Math.floor(ERA_FUND_EXTRA_CARDS_RAW))
  : 5;

const SET_QUERY_OVERRIDES = {
  base1: { setId: "102", setName: "Base Set" },
  base2: { setId: "103", setName: "Jungle" },
  neo1: { setId: "110", setName: "Neo Genesis" },
  gym1: { setId: "108", setName: "Gym Heroes" },
  ex1: { setId: "119", setName: "EX Ruby & Sapphire" },
  sm1: { setId: "239", setName: "Sun & Moon" },
  swsh1: { setId: "272", setName: "Sword & Shield" },
  sv1: { setId: "507", setName: "Scarlet & Violet" },
  dp1: { setId: "138", setName: "Diamond & Pearl" },
  dp2: { setId: "143", setName: "Mysterious Treasures" },
  dp3: { setId: "148", setName: "Secret Wonders" },
  dp4: { setId: "151", setName: "Great Encounters" },
  dp5: { setId: "158", setName: "Majestic Dawn" },
  dp6: { setId: "162", setName: "Legends Awakened" },
  dp7: { setId: "166", setName: "Stormfront" },
  pl1: { setId: "176", setName: "Platinum" },
  pl2: { setId: "180", setName: "Rising Rivals" },
  pl3: { setId: "184", setName: "Supreme Victors" },
  pl4: { setId: "188", setName: "Arceus" },
  hgss1: { setId: "200", setName: "HeartGold & SoulSilver" },
  hgss2: { setId: "204", setName: "HS Unleashed" },
  hgss3: { setId: "208", setName: "HS Undaunted" },
  hgss4: { setId: "211", setName: "HS Triumphant" },
};

const FUNDS = [
  {
    id: "poke-global",
    name: "PokeMarket 100 Index",
    type: "broad",
    description:
      "Broad index-fund exposure across iconic and high-liquidity Pokemon sets.",
    setWeights: {
      base1: 0.2,
      base2: 0.09,
      neo1: 0.09,
      gym1: 0.07,
      ex1: 0.08,
      sm1: 0.08,
      swsh1: 0.1,
      sv1: 0.08,
      dp1: 0.07,
      pl1: 0.07,
      hgss1: 0.07,
    },
  },
  {
    id: "diamond-pearl",
    name: "Diamond & Pearl Era Index Fund",
    type: "era",
    description:
      "Exposure focused on Diamond & Pearl era vintage-modern crossover cards.",
    setWeights: {
      dp1: 0.2,
      dp2: 0.17,
      dp3: 0.16,
      dp4: 0.16,
      dp5: 0.11,
      dp6: 0.1,
      dp7: 0.1,
    },
  },
  {
    id: "platinum",
    name: "Platinum Era Index Fund",
    type: "era",
    description:
      "Thematic index fund tracking key cards in the Platinum expansion cycle.",
    setWeights: {
      pl1: 0.35,
      pl2: 0.23,
      pl3: 0.21,
      pl4: 0.21,
    },
  },
  {
    id: "heartgold-soulsilver",
    name: "HeartGold & SoulSilver Index Fund",
    type: "era",
    description:
      "Thematic index fund focused on HGSS-era cards and associated collector demand.",
    setWeights: {
      hgss1: 0.31,
      hgss2: 0.24,
      hgss3: 0.23,
      hgss4: 0.22,
    },
  },
];

const cache = new Map();
let allFundsInFlightPromise = null;

const portfolio = {
  cashGBP: 10000,
  holdings: {},
  transactions: [],
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, createdAt: Date.now() });
}

function parseBooleanFlag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeIndexLanguage(text) {
  if (text == null) return "";
  return String(text)
    .replace(/\bETF-style\b/gi, "index-style")
    .replace(/\bETF\b/g, "Index")
    .replace(/\betf\b/g, "index");
}

function readDiskFundsCache() {
  try {
    if (!fs.existsSync(DISK_CACHE_FILE)) return null;
    const raw = fs.readFileSync(DISK_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.funds) || !parsed.savedAt) return null;
    const savedAtMs = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAtMs)) return null;
    const maxAgeMs = DISK_CACHE_MAX_AGE_HOURS * 60 * 60 * 1000;
    if (Date.now() - savedAtMs > maxAgeMs) return null;
    return parsed;
  } catch (_err) {
    return null;
  }
}

function writeDiskFundsCache(funds) {
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      source: "pokemon-etf-backend",
      config: {
        apiBaseUrl: TCG_BASE_URL,
        historyDays: API_HISTORY_DAYS,
        cardsPerSet: ETF_CARDS_PER_SET,
        broadFundExtraCards: BROAD_FUND_EXTRA_CARDS,
        eraFundExtraCards: ERA_FUND_EXTRA_CARDS,
      },
      funds,
    };
    fs.writeFileSync(DISK_CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (_err) {
    // Ignore disk cache write failures; runtime API data still flows.
  }
}

function enrichFundsWithDatabaseHistory(funds) {
  if (!Array.isArray(funds) || funds.length === 0) return [];

  // Save one snapshot per fund per day. Same-day reruns simply update that day.
  upsertDailyFundSnapshots(funds);

  return funds.map((fund) => {
    const normalizedConstituents = normalizeConstituentContributions(fund.constituents);
    const weightedBasketPrice = normalizedConstituents.reduce((sum, card) => {
      const price = safeNumber(card?.priceGBP, NaN);
      const contributionPct = safeNumber(card?.contribution, NaN);
      if (!Number.isFinite(price) || price <= 0) return sum;
      if (!Number.isFinite(contributionPct) || contributionPct <= 0) return sum;
      return sum + price * (contributionPct / 100);
    }, 0);
    const declaredPrice = safeNumber(
      fund.priceGBP ?? fund.blendedPriceGBP ?? fund.nav,
      NaN
    );
    const currentPrice = Number.isFinite(weightedBasketPrice) && weightedBasketPrice > 0
      ? weightedBasketPrice
      : declaredPrice;

    const dbHistoryRaw = getFundHistory(fund.id, 3650);
    const incomingHistoryRaw = Array.isArray(fund.history) ? fund.history : [];
    const derivedHistoryRaw = buildFundHistoryFromConstituents(fund);

    const normalizeHistory = (list) =>
      list
        .map((point) => ({
          date: String(point?.date || "").slice(0, 10),
          price: safeNumber(point?.price ?? point?.nav, NaN),
        }))
        .filter((point) => point.date && Number.isFinite(point.price) && point.price > 0)
        .sort((a, b) => a.date.localeCompare(b.date));

    const historyRange = (list) => {
      if (!list.length) return 0;
      const values = list.map((p) => p.price);
      const min = Math.min(...values);
      const max = Math.max(...values);
      return max - min;
    };

    const incomingHistory = normalizeHistory(incomingHistoryRaw);
    const derivedHistory = normalizeHistory(derivedHistoryRaw);
    const dbHistory = normalizeHistory(dbHistoryRaw);

    const candidates = [
      { source: fund.historySource || "incoming", points: incomingHistory, order: 3 },
      { source: "derived-from-constituents", points: derivedHistory, order: 2 },
      { source: "database", points: dbHistory, order: 1 },
    ];

    const historyScore = (candidate) => {
      const points = candidate.points;
      const range = historyRange(points);
      const hasSignal = points.length >= 2 && range > 1e-6;
      return (hasSignal ? 1_000_000 : 0) + points.length * 1_000 + range * 10 + candidate.order;
    };

    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (historyScore(candidate) > historyScore(best)) {
        best = candidate;
      }
    }

    let history = best.points;
    let historySource = best.source;

    if (history.length === 0) {
      history = buildFlatHistory(
        Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : ETF_BASE_NAV,
        API_HISTORY_DAYS
      );
    }
    if (history.length === 1) {
      const d = new Date(history[0].date);
      d.setDate(d.getDate() - 1);
      history.unshift({
        date: d.toISOString().slice(0, 10),
        price: history[0].price,
      });
    }

    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      history[history.length - 1].price = Number(currentPrice.toFixed(6));
    }
    const priceForChange =
      Number.isFinite(currentPrice) && currentPrice > 0
        ? currentPrice
        : history[history.length - 1]?.price || 0;
    const prev = history[Math.max(0, history.length - 2)]?.price || priceForChange;
    const recomputedDayChange = prev ? ((priceForChange - prev) / prev) * 100 : 0;
    const { nav: _legacyNav, ...fundWithoutLegacyNav } = fund;
    const effectivePrice = Number.isFinite(currentPrice) && currentPrice > 0
      ? currentPrice
      : safeNumber(fundWithoutLegacyNav.blendedPriceGBP, NaN);

    return {
      ...fundWithoutLegacyNav,
      name: normalizeIndexLanguage(fundWithoutLegacyNav.name || ""),
      description: normalizeIndexLanguage(fundWithoutLegacyNav.description || ""),
      priceGBP:
        Number.isFinite(effectivePrice) && effectivePrice > 0
          ? Number(effectivePrice.toFixed(2))
          : undefined,
      blendedPriceGBP:
        Number.isFinite(effectivePrice) && effectivePrice > 0
          ? Number(effectivePrice.toFixed(2))
          : 0,
      history,
      historySource,
      dayChangePct: Number(recomputedDayChange.toFixed(2)),
      constituents: normalizedConstituents,
    };
  });
}

function getFundIds() {
  return FUNDS.map((fund) => fund.id);
}

function safeNumber(value, fallback = 0) {
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.+-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeConstituentContributions(constituents) {
  if (!Array.isArray(constituents) || constituents.length === 0) return [];

  const normalized = constituents.map((card) => ({ ...card }));
  const bySet = new Map();

  for (let i = 0; i < normalized.length; i += 1) {
    const card = normalized[i];
    const setKey = String(card?.setId || card?.setName || `__card_${i}`);
    let entry = bySet.get(setKey);
    if (!entry) {
      entry = { weight: NaN, indexes: [] };
      bySet.set(setKey, entry);
    }
    entry.indexes.push(i);

    const w = safeNumber(card?.setWeight, NaN);
    if (Number.isFinite(w) && w > 0) {
      if (!Number.isFinite(entry.weight) || entry.weight <= 0) {
        entry.weight = w;
      }
    }
  }

  const totalActiveSetWeight = Array.from(bySet.values()).reduce((sum, entry) => {
    const w = safeNumber(entry.weight, NaN);
    return Number.isFinite(w) && w > 0 ? sum + w : sum;
  }, 0);

  if (!(totalActiveSetWeight > 0)) {
    const equal = 100 / normalized.length;
    for (const card of normalized) {
      card.contribution = Number(equal.toFixed(6));
    }
  } else {
    for (const entry of bySet.values()) {
      const setWeight = safeNumber(entry.weight, 0);
      const cardCount = Math.max(1, entry.indexes.length);
      const setShare = setWeight / totalActiveSetWeight;
      const perCardContribution = (setShare / cardCount) * 100;
      for (const idx of entry.indexes) {
        normalized[idx].contribution = Number(perCardContribution.toFixed(6));
      }
    }
  }

  const sum = normalized.reduce(
    (acc, card) => acc + safeNumber(card?.contribution, 0),
    0
  );
  const diff = 100 - sum;
  if (normalized.length > 0 && Number.isFinite(diff) && Math.abs(diff) > 1e-9) {
    const lastIndex = normalized.length - 1;
    const adjusted =
      safeNumber(normalized[lastIndex]?.contribution, 0) + diff;
    normalized[lastIndex].contribution = Number(adjusted.toFixed(6));
  }

  return normalized;
}

function pickCardPrice(card) {
  const price = safeNumber(card?.prices?.market, NaN);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function normalizeDateKey(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    const asDate = new Date(millis);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    if (/^\d{10,13}$/.test(trimmed)) {
      const asNum = Number(trimmed);
      const millis = trimmed.length === 13 ? asNum : asNum * 1000;
      const asDate = new Date(millis);
      return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString().slice(0, 10);
    }
    const asDate = new Date(trimmed);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString().slice(0, 10);
  }
  return null;
}

function extractHistoryArrays(card) {
  const arrays = [];
  const candidates = [
    card?.history,
    card?.priceHistory,
    card?.pricingHistory,
    card?.marketHistory,
    card?.prices?.history,
    card?.prices?.marketHistory,
  ];

  const visited = new Set();
  function walk(value) {
    if (value == null) return;
    if (typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      arrays.push(value);
      for (const item of value) walk(item);
      return;
    }
    for (const nested of Object.values(value)) {
      walk(nested);
    }
  }

  for (const candidate of candidates) walk(candidate);
  return arrays;
}

function extractCardHistory(card) {
  const byDate = new Map();
  const historyCandidates = [
    card?.history,
    card?.priceHistory,
    card?.pricingHistory,
    card?.marketHistory,
    card?.prices?.history,
    card?.prices?.marketHistory,
  ];
  const arrays = extractHistoryArrays(card);

  for (const historyList of arrays) {
    for (const point of historyList) {
      if (!point || typeof point !== "object") continue;
      const date = normalizeDateKey(
        point.date ??
          point.day ??
          point.x ??
          point.timestamp ??
          point.time ??
          point.recordedAt ??
          point.updatedAt
      );
      if (!date) continue;

      const candidates = [
        point.market,
        point.price,
        point.marketPrice,
        point.value,
        point.close,
        point.avg,
        point.y,
        point.v,
        point.prices?.market,
      ];
      let price = null;
      for (const value of candidates) {
        const parsed = safeNumber(value, NaN);
        if (Number.isFinite(parsed) && parsed > 0) {
          price = parsed;
          break;
        }
      }
      if (!price) continue;
      byDate.set(date, price);
    }
  }

  const visited = new Set();
  function walkHistoryMap(value) {
    if (value == null || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walkHistoryMap(item);
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      const keyDate = normalizeDateKey(key);
      if (keyDate) {
        const candidates = [
          nested,
          nested?.market,
          nested?.price,
          nested?.value,
          nested?.close,
          nested?.avg,
          nested?.prices?.market,
        ];
        for (const candidate of candidates) {
          const parsed = safeNumber(candidate, NaN);
          if (Number.isFinite(parsed) && parsed > 0) {
            byDate.set(keyDate, parsed);
            break;
          }
        }
      }
      if (nested && typeof nested === "object") {
        walkHistoryMap(nested);
      }
    }
  }

  for (const candidate of historyCandidates) {
    walkHistoryMap(candidate);
  }

  const currentPrice = pickCardPrice(card);
  const currentDate = normalizeDateKey(card?.prices?.lastUpdated || card?.lastUpdated || Date.now());
  if (byDate.size > 0 && currentDate && currentPrice) {
    byDate.set(currentDate, currentPrice);
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, price]) => ({
      date,
      price: Number(price.toFixed(6)),
    }));
}

function isNumericId(value) {
  return /^\d+$/.test(String(value || ""));
}

async function fetchCardsPage(params) {
  const qs = new URLSearchParams(params);
  const url = `${TCG_BASE_URL}/cards?${qs.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${POKEPRICE_API_KEY}`,
      "X-PokePrice-Key": POKEPRICE_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Cards API request failed: ${response.status}`);
  }

  const payload = await response.json();
  return {
    data: Array.isArray(payload?.data) ? payload.data : [],
    metadata: payload?.metadata || {},
  };
}

function normalizeCard(card, fallbackSetId, fallbackSetName) {
  const price = pickCardPrice(card);
  if (!price) return null;
  return {
    id: card.id || String(card.tcgPlayerId || card.cardId || ""),
    name: card.name || "Unknown",
    number: card.cardNumber || "",
    setId: fallbackSetId,
    setName: card.setName || fallbackSetName || fallbackSetId,
    rarity: card.rarity || "Unknown",
    cardType: card.cardType || "Unknown",
    image: card.imageCdnUrl200 || card.imageCdnUrl400 || "",
    priceGBP: price,
    history: extractCardHistory(card),
  };
}

async function fetchCardsForSet(setId, targetCount = 80) {
  const cacheKey = `set:${setId}:${targetCount}:${API_DEFAULT_LANGUAGE}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const override = SET_QUERY_OVERRIDES[setId] || {};
  const exactSetId = override.setId || (isNumericId(setId) ? String(setId) : null);
  const fallbackSetName = override.setName || setId;
  let lastError = null;

  const is403Error = (err) => String(err?.message || "").includes("403");

  async function fetchByParams(baseParams, includeHistory = true) {
    const collected = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore && collected.length < targetCount) {
      const params = {
        language: API_DEFAULT_LANGUAGE,
        sortBy: "price",
        sortOrder: "desc",
        limit: Math.min(API_PAGE_LIMIT_WITH_HISTORY, targetCount),
        offset,
        ...baseParams,
      };
      if (includeHistory) {
        params.includeHistory = "true";
        params.days = String(API_HISTORY_DAYS);
      }

      const { data, metadata } = await fetchCardsPage(params);
      const mapped = data
        .map((card) => normalizeCard(card, setId, fallbackSetName))
        .filter(Boolean);
      collected.push(...mapped);

      const pageLimit = safeNumber(
        metadata?.limit,
        Math.min(API_PAGE_LIMIT_WITH_HISTORY, targetCount)
      );
      hasMore = Boolean(metadata?.hasMore);
      offset += pageLimit;
      if (data.length === 0) break;
    }
    return collected;
  }

  async function fetchWithHistoryFallback(baseParams) {
    try {
      return await fetchByParams(baseParams, true);
    } catch (err) {
      lastError = err;
      if (!is403Error(err)) return [];
      try {
        return await fetchByParams(baseParams, false);
      } catch (fallbackErr) {
        lastError = fallbackErr;
        return [];
      }
    }
  }

  let cards = [];
  if (exactSetId) {
    cards = await fetchWithHistoryFallback({
      setId: exactSetId,
      fetchAllInSet: "true",
    });
  }

  if (cards.length === 0 && fallbackSetName) {
    cards = await fetchWithHistoryFallback({
      set: fallbackSetName,
      fetchAllInSet: "true",
    });
  }

  if (cards.length === 0 && fallbackSetName) {
    cards = await fetchWithHistoryFallback({ search: fallbackSetName });
  }

  cards.sort((a, b) => b.priceGBP - a.priceGBP);

  if (cards.length === 0 && lastError) {
    throw new Error(`Set ${setId} failed: ${lastError.message}`);
  }

  cacheSet(cacheKey, cards);
  return cards;
}

function buildFlatHistory(price, days = API_HISTORY_DAYS) {
  const safePrice = Number.isFinite(price) && price > 0 ? price : ETF_BASE_NAV;
  const count = Math.max(2, Math.floor(safeNumber(days, API_HISTORY_DAYS)));
  const points = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    points.push({
      date: d.toISOString().slice(0, 10),
      price: Number(safePrice.toFixed(2)),
    });
  }
  return points;
}

function priceAtOrBeforeDate(history, date) {
  if (!history.length) return null;
  let picked = null;
  for (const point of history) {
    if (point.date <= date) picked = point.price;
    else break;
  }
  return picked;
}

function buildFundRawHistory(setSnapshots) {
  const weightedCards = [];
  for (const setInfo of setSnapshots) {
    if (!setInfo.cards.length) continue;
    const perCardWeight = setInfo.setWeight / setInfo.cards.length;
    for (const card of setInfo.cards) {
      const history = Array.isArray(card.history)
        ? card.history
            .filter((point) => point && point.date && Number.isFinite(point.price))
            .slice()
            .sort((a, b) => a.date.localeCompare(b.date))
        : [];
      weightedCards.push({
        weight: perCardWeight,
        currentPrice: card.priceGBP,
        history,
      });
    }
  }

  if (!weightedCards.length) return [];

  const dateSet = new Set();
  for (const card of weightedCards) {
    for (const point of card.history) {
      dateSet.add(point.date);
    }
  }
  if (!dateSet.size) return [];

  const dates = Array.from(dateSet).sort((a, b) => a.localeCompare(b));
  return dates
    .map((date) => {
      let weightedSum = 0;
      let usedWeight = 0;
      for (const card of weightedCards) {
        const historyPrice = priceAtOrBeforeDate(card.history, date);
        const price = Number.isFinite(historyPrice) && historyPrice > 0 ? historyPrice : card.currentPrice;
        if (!Number.isFinite(price) || price <= 0) continue;
        weightedSum += card.weight * price;
        usedWeight += card.weight;
      }
      if (usedWeight <= 0) return null;
      return {
        date,
        price: Number((weightedSum / usedWeight).toFixed(4)),
      };
    })
    .filter(Boolean);
}

function buildFundHistoryFromConstituents(fund) {
  const constituents = Array.isArray(fund?.constituents) ? fund.constituents : [];
  if (constituents.length === 0) return [];

  const mapped = constituents
    .map((card) => {
      const rawWeight = safeNumber(card?.contribution, NaN);
      const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight / 100 : null;
      const currentPrice = safeNumber(card?.priceGBP, NaN);
      const history = Array.isArray(card?.history)
        ? card.history
            .map((point) => ({
              date: String(point?.date || "").slice(0, 10),
              price: safeNumber(point?.price, NaN),
            }))
            .filter(
              (point) => point.date && Number.isFinite(point.price) && point.price > 0
            )
            .sort((a, b) => a.date.localeCompare(b.date))
        : [];

      return {
        weight,
        currentPrice: Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : null,
        history,
      };
    })
    .filter((row) => row.currentPrice || row.history.length > 0);

  if (!mapped.length) return [];

  let hasDefinedWeights = mapped.some((row) => Number.isFinite(row.weight) && row.weight > 0);
  if (!hasDefinedWeights) {
    const equalWeight = 1 / mapped.length;
    for (const row of mapped) {
      row.weight = equalWeight;
    }
  }

  const dateSet = new Set();
  for (const row of mapped) {
    for (const point of row.history) {
      dateSet.add(point.date);
    }
  }
  if (dateSet.size === 0) return [];

  const dates = Array.from(dateSet).sort((a, b) => a.localeCompare(b));
  const rawSeries = dates
    .map((date) => {
      let weightedSum = 0;
      let usedWeight = 0;
      for (const row of mapped) {
        const historyPrice = priceAtOrBeforeDate(row.history, date);
        const price =
          Number.isFinite(historyPrice) && historyPrice > 0 ? historyPrice : row.currentPrice;
        if (!Number.isFinite(price) || price <= 0) continue;
        const w = Number.isFinite(row.weight) && row.weight > 0 ? row.weight : 0;
        weightedSum += w * price;
        usedWeight += w;
      }
      if (usedWeight <= 0) return null;
      return { date, value: weightedSum / usedWeight };
    })
    .filter(Boolean);

  if (rawSeries.length === 0) return [];
  const latestRaw = rawSeries[rawSeries.length - 1].value;
  const currentPrice = safeNumber(
    fund?.priceGBP ?? fund?.blendedPriceGBP ?? fund?.nav,
    NaN
  );
  if (
    !Number.isFinite(latestRaw) ||
    latestRaw <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return [];
  }

  return rawSeries
    .map((point) => ({
      date: point.date,
      price: Number(((point.value / latestRaw) * currentPrice).toFixed(6)),
    }))
    .filter((point) => Number.isFinite(point.price) && point.price > 0);
}

function normalizeWeights(weightMap) {
  const entries = Object.entries(weightMap);
  const total = entries.reduce((sum, [, w]) => sum + safeNumber(w), 0) || 1;
  return Object.fromEntries(entries.map(([k, v]) => [k, safeNumber(v) / total]));
}

function getTargetCardCountForFund(fund) {
  const setCount = Object.keys(fund?.setWeights || {}).length;
  if (setCount <= 0) return 0;
  const extraCards =
    fund?.type === "broad" ? BROAD_FUND_EXTRA_CARDS : ERA_FUND_EXTRA_CARDS;
  const extra = Math.max(0, Math.floor(safeNumber(extraCards, 0)));
  return setCount + extra;
}

function allocateCardsAcrossSets(weightMap, totalCards) {
  const weights = normalizeWeights(weightMap);
  const entries = Object.entries(weights);
  if (!entries.length) return {};

  const minCards = entries.length;
  const normalizedTotalCards = Math.max(
    minCards,
    Math.floor(safeNumber(totalCards, minCards))
  );

  const allocations = Object.fromEntries(entries.map(([setId]) => [setId, 1]));
  let remaining = normalizedTotalCards - minCards;
  if (remaining <= 0) return allocations;

  let assignedByFloor = 0;
  const remainders = entries.map(([setId, weight]) => {
    const exact = weight * remaining;
    const floorExtra = Math.floor(exact);
    allocations[setId] += floorExtra;
    assignedByFloor += floorExtra;
    return { setId, remainder: exact - floorExtra };
  });

  let leftovers = remaining - assignedByFloor;
  remainders.sort(
    (a, b) => b.remainder - a.remainder || a.setId.localeCompare(b.setId)
  );
  while (leftovers > 0) {
    const nextSet = remainders.shift();
    if (!nextSet) break;
    allocations[nextSet.setId] += 1;
    leftovers -= 1;
    remainders.push(nextSet);
  }

  return allocations;
}

async function computeFund(fund) {
  const weights = normalizeWeights(fund.setWeights);
  const setEntries = Object.entries(weights);
  const targetCardCount = getTargetCardCountForFund(fund);
  const setCardTargets = allocateCardsAcrossSets(weights, targetCardCount);

  const setSnapshots = [];
  for (const [setId, setWeight] of setEntries) {
    const targetCardsForSet = Math.max(
      1,
      Math.floor(safeNumber(setCardTargets[setId], ETF_CARDS_PER_SET))
    );

    try {
      const cards = await fetchCardsForSet(setId, targetCardsForSet);
      const top = cards.slice(0, targetCardsForSet);
      const averageTop = top.length
        ? top.reduce((sum, card) => sum + card.priceGBP, 0) / top.length
        : 0;
      setSnapshots.push({
        setId,
        setWeight,
        cards: top,
        targetCards: targetCardsForSet,
        setAverage: averageTop,
        loadError: null,
      });
    } catch (err) {
      setSnapshots.push({
        setId,
        setWeight,
        cards: [],
        targetCards: targetCardsForSet,
        setAverage: 0,
        loadError: err?.message || "Unknown set fetch failure",
      });
    }
  }

  const blendedPrice = setSnapshots.reduce(
    (sum, item) => sum + item.setAverage * item.setWeight,
    0
  );
  const rawConstituents = setSnapshots.flatMap((setInfo) =>
    setInfo.cards.map((card, index) => ({
      ...card,
      setWeight: setInfo.setWeight,
      rankInSet: index + 1,
      contribution: 0,
    }))
  );
  const constituents = normalizeConstituentContributions(rawConstituents);
  const weightedBasketPrice = constituents.reduce((sum, card) => {
    const price = safeNumber(card?.priceGBP, 0);
    const contribution = safeNumber(card?.contribution, 0) / 100;
    if (price <= 0 || contribution <= 0) return sum;
    return sum + price * contribution;
  }, 0);
  const basketPrice = safeNumber(weightedBasketPrice, 0) > 0 ? weightedBasketPrice : blendedPrice;

  const hasLiveData = setSnapshots.length > 0 && basketPrice > 0;
  const rawHistory = buildFundRawHistory(setSnapshots);
  let history = [];
  const hasTrueHistory = rawHistory.length > 0;
  if (hasTrueHistory) {
    const latestRawPrice = rawHistory[rawHistory.length - 1].price;
    const currentBasketPrice = hasLiveData ? basketPrice : latestRawPrice;
    const scale =
      Number.isFinite(latestRawPrice) &&
      latestRawPrice > 0 &&
      Number.isFinite(currentBasketPrice) &&
      currentBasketPrice > 0
        ? currentBasketPrice / latestRawPrice
        : 1;
    history = rawHistory
      .map((point) => ({
        date: point.date,
        price: Number((point.price * scale).toFixed(6)),
      }))
      .filter((point) => Number.isFinite(point.price) && point.price > 0);
  }
  if (history.length === 0) {
    history = buildFlatHistory(
      Number.isFinite(basketPrice) && basketPrice > 0 ? basketPrice : ETF_BASE_NAV,
      API_HISTORY_DAYS
    );
  }
  if (history.length === 1) {
    const d = new Date(history[0].date);
    d.setDate(d.getDate() - 1);
    history.unshift({
      date: d.toISOString().slice(0, 10),
      price: history[0].price,
    });
  }
  const currentPrice =
    Number.isFinite(basketPrice) && basketPrice > 0
      ? basketPrice
      : history[history.length - 1]?.price || ETF_BASE_NAV;
  history[history.length - 1].price = Number(currentPrice.toFixed(6));
  const prev = history[Math.max(0, history.length - 2)]?.price || currentPrice;
  const dayChangePct = prev ? ((currentPrice - prev) / prev) * 100 : 0;

  return {
    id: fund.id,
    name: fund.name,
    type: fund.type,
    description: fund.description,
    priceGBP: Number(currentPrice.toFixed(2)),
    blendedPriceGBP: Number(currentPrice.toFixed(2)),
    dayChangePct: Number(dayChangePct.toFixed(2)),
    history,
    sets: setSnapshots.map((s) => ({
      setId: s.setId,
      setWeight: Number((s.setWeight * 100).toFixed(2)),
      cardsUsed: s.cards.length,
      cardsTarget: s.targetCards,
      setAverageGBP: Number(s.setAverage.toFixed(2)),
      loadError: s.loadError || undefined,
    })),
    constituents,
    asOf: new Date().toISOString(),
    historySource: hasTrueHistory ? "api" : "fallback",
    warning: undefined,
  };
}

function hasLiveLikeFundData(fund) {
  if (!fund || typeof fund !== "object") return false;
  const hasPrice =
    safeNumber(fund.priceGBP, 0) > 0 || safeNumber(fund.blendedPriceGBP, 0) > 0;
  const hasCards = Array.isArray(fund.constituents) && fund.constituents.length > 0;
  const hasSetData =
    Array.isArray(fund.sets) &&
    fund.sets.some(
      (setInfo) =>
        safeNumber(setInfo?.cardsUsed, 0) > 0 || safeNumber(setInfo?.setAverageGBP, 0) > 0
    );
  return hasPrice || hasCards || hasSetData;
}

function getFundDataQualityScore(fund) {
  if (!fund || typeof fund !== "object") return -1;
  let score = 0;
  if (hasLiveLikeFundData(fund)) score += 1000;

  const price = safeNumber(fund.priceGBP ?? fund.blendedPriceGBP, 0);
  if (price > 0) score += Math.min(500, price);

  const cards = Array.isArray(fund.constituents) ? fund.constituents.length : 0;
  score += Math.min(800, cards * 10);

  const historyLen = Array.isArray(fund.history) ? fund.history.length : 0;
  score += Math.min(200, historyLen * 5);

  const hasSetErrors =
    Array.isArray(fund?.sets) && fund.sets.some((setInfo) => Boolean(setInfo?.loadError));
  if (hasSetErrors) score -= 120;

  return score;
}

function hasAnyLiveLikeFunds(funds) {
  return Array.isArray(funds) && funds.some((fund) => hasLiveLikeFundData(fund));
}

function mergeFundsWithDatabaseFallback(computedFunds, dbFallbackFunds) {
  const computedById = new Map(
    (Array.isArray(computedFunds) ? computedFunds : [])
      .filter((fund) => fund?.id)
      .map((fund) => [fund.id, fund])
  );
  const dbById = new Map(
    (Array.isArray(dbFallbackFunds) ? dbFallbackFunds : [])
      .filter((fund) => fund?.id)
      .map((fund) => [fund.id, fund])
  );

  const merged = [];
  for (const templateFund of FUNDS) {
    const canonicalFields = {
      name: normalizeIndexLanguage(templateFund.name),
      type: templateFund.type,
      description: normalizeIndexLanguage(templateFund.description),
    };
    const computed = computedById.get(templateFund.id);
    const dbFund = dbById.get(templateFund.id);
    if (computed && dbFund) {
      const computedScore = getFundDataQualityScore(computed);
      const dbScore = getFundDataQualityScore(dbFund);
      if (computedScore >= dbScore) {
        merged.push({ ...computed, ...canonicalFields, warning: undefined });
      } else {
        merged.push({
          ...dbFund,
          ...canonicalFields,
          warning: undefined,
          historySource: "database",
        });
      }
      continue;
    }
    if (computed) {
      merged.push({ ...computed, ...canonicalFields, warning: undefined });
      continue;
    }
    if (dbFund) {
      merged.push({
        ...dbFund,
        ...canonicalFields,
        warning: undefined,
        historySource: "database",
      });
    }
  }

  return merged;
}

async function getAllFunds(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const cacheKey = "allFunds";
  const cached = !forceRefresh ? cacheGet(cacheKey) : null;
  if (cached) {
    const enrichedCached = enrichFundsWithDatabaseHistory(cached);
    cacheSet(cacheKey, enrichedCached);
    return enrichedCached;
  }

  if (!forceRefresh) {
    const dbDailySnapshots = getDailyFundSnapshots(getFundIds(), new Date().toISOString());
    if (dbDailySnapshots?.length) {
      const enrichedDbDailySnapshots = enrichFundsWithDatabaseHistory(dbDailySnapshots);
      const fundIds = getFundIds();
      const hasRichDbHistory = fundIds.every((fundId) => getFundHistory(fundId, 3650).length >= 2);
      if (hasRichDbHistory && hasAnyLiveLikeFunds(enrichedDbDailySnapshots)) {
        cacheSet(cacheKey, enrichedDbDailySnapshots);
        return enrichedDbDailySnapshots;
      }

      const latestDbSnapshots = getLatestFundSnapshots(fundIds);
      if (latestDbSnapshots?.length) {
        const enrichedLatestDbSnapshots = enrichFundsWithDatabaseHistory(latestDbSnapshots);
        if (hasAnyLiveLikeFunds(enrichedLatestDbSnapshots)) {
          cacheSet(cacheKey, enrichedLatestDbSnapshots);
          return enrichedLatestDbSnapshots;
        }
      }

      const diskCachedForBackfill = readDiskFundsCache();
      if (diskCachedForBackfill?.funds?.length) {
        const enrichedDiskCached = enrichFundsWithDatabaseHistory(diskCachedForBackfill.funds);
        if (hasAnyLiveLikeFunds(enrichedDiskCached)) {
          cacheSet(cacheKey, enrichedDiskCached);
          return enrichedDiskCached;
        }
      }

      cacheSet(cacheKey, enrichedDbDailySnapshots);
      return enrichedDbDailySnapshots;
    }

    const diskCached = readDiskFundsCache();
    if (diskCached?.funds?.length) {
      const enrichedDiskCached = enrichFundsWithDatabaseHistory(diskCached.funds);
      if (hasAnyLiveLikeFunds(enrichedDiskCached)) {
        cacheSet(cacheKey, enrichedDiskCached);
        return enrichedDiskCached;
      }
    }
  }

  if (allFundsInFlightPromise) {
    return allFundsInFlightPromise;
  }

  allFundsInFlightPromise = (async () => {
    const settled = await Promise.allSettled(FUNDS.map((fund) => computeFund(fund)));
    const computedFunds = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const dbFallbackFunds = getLatestFundSnapshots(getFundIds());
    const funds = mergeFundsWithDatabaseFallback(computedFunds, dbFallbackFunds);
    if (funds.length === 0) {
      const fallbackFunds = FUNDS.map((fund) => ({
        id: fund.id,
        name: fund.name,
        type: fund.type,
        description: fund.description,
        priceGBP: ETF_BASE_NAV,
        blendedPriceGBP: ETF_BASE_NAV,
        dayChangePct: 0,
        history: buildFlatHistory(ETF_BASE_NAV, API_HISTORY_DAYS),
        sets: [],
        constituents: [],
        asOf: new Date().toISOString(),
        historySource: "fallback",
        warning: undefined,
      }));
      const enrichedFallbackFunds = enrichFundsWithDatabaseHistory(fallbackFunds);
      cacheSet(cacheKey, enrichedFallbackFunds);
      return enrichedFallbackFunds;
    }
    const enrichedFunds = enrichFundsWithDatabaseHistory(funds);
    cacheSet(cacheKey, enrichedFunds);
    const hasLiveLikeData = hasAnyLiveLikeFunds(funds);
    if (hasLiveLikeData) {
      writeDiskFundsCache(enrichedFunds);
    }

    // Immediately persist enriched series so future DB-first loads do not flatten.
    upsertDailyFundSnapshots(enrichedFunds);

    return enrichedFunds;
  })();

  try {
    return await allFundsInFlightPromise;
  } finally {
    allFundsInFlightPromise = null;
  }
}

function summarizePortfolio(funds) {
  const byId = Object.fromEntries(funds.map((f) => [f.id, f]));
  const positions = Object.entries(portfolio.holdings).map(([fundId, units]) => {
    const fund = byId[fundId];
    const unitPrice = safeNumber(fund?.priceGBP ?? fund?.blendedPriceGBP ?? fund?.nav, 0);
    const marketValue = unitPrice * units;
    return {
      fundId,
      fundName: fund?.name || fundId,
      units: Number(units.toFixed(6)),
      priceGBP: Number(unitPrice.toFixed(2)),
      marketValueGBP: Number(marketValue.toFixed(2)),
    };
  });

  const holdingsValue = positions.reduce((sum, p) => sum + p.marketValueGBP, 0);
  const totalValue = holdingsValue + portfolio.cashGBP;
  const netInvested = portfolio.transactions.reduce((sum, tx) => {
    if (tx.type === "BUY") return sum + tx.amountGBP;
    if (tx.type === "SELL") return sum - tx.amountGBP;
    return sum;
  }, 0);
  const pnl = totalValue - (10000 + 0);
  const pnlPct = 10000 ? (pnl / 10000) * 100 : 0;

  return {
    cashGBP: Number(portfolio.cashGBP.toFixed(2)),
    holdingsValueGBP: Number(holdingsValue.toFixed(2)),
    totalValueGBP: Number(totalValue.toFixed(2)),
    netInvestedGBP: Number(netInvested.toFixed(2)),
    pnlGBP: Number(pnl.toFixed(2)),
    pnlPct: Number(pnlPct.toFixed(2)),
    positions,
    transactions: portfolio.transactions.slice(-30).reverse(),
  };
}

async function handleBuy(body, funds) {
  const fundId = String(body.fundId || "");
  const amountGBP = safeNumber(body.amountGBP, 0);
  if (!fundId || amountGBP <= 0) {
    return { status: 400, payload: { error: "fundId and positive amountGBP are required." } };
  }

  const fund = funds.find((f) => f.id === fundId);
  if (!fund) {
    return { status: 404, payload: { error: "Fund not found." } };
  }
  const unitPrice = safeNumber(fund.priceGBP ?? fund.blendedPriceGBP ?? fund.nav, NaN);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return {
      status: 400,
      payload: { error: "Fund price unavailable. Refresh when live pricing is back." },
    };
  }
  if (portfolio.cashGBP < amountGBP) {
    return { status: 400, payload: { error: "Insufficient cash balance." } };
  }

  const units = amountGBP / unitPrice;
  portfolio.cashGBP -= amountGBP;
  portfolio.holdings[fundId] = (portfolio.holdings[fundId] || 0) + units;
  portfolio.transactions.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "BUY",
    fundId,
    fundName: fund.name,
    amountGBP: Number(amountGBP.toFixed(2)),
    units: Number(units.toFixed(6)),
    priceAtTrade: Number(unitPrice.toFixed(2)),
    time: new Date().toISOString(),
  });

  return { status: 200, payload: summarizePortfolio(funds) };
}

async function handleSell(body, funds) {
  const fundId = String(body.fundId || "");
  const amountGBP = safeNumber(body.amountGBP, 0);
  if (!fundId || amountGBP <= 0) {
    return { status: 400, payload: { error: "fundId and positive amountGBP are required." } };
  }
  const fund = funds.find((f) => f.id === fundId);
  if (!fund) {
    return { status: 404, payload: { error: "Fund not found." } };
  }
  const unitPrice = safeNumber(fund.priceGBP ?? fund.blendedPriceGBP ?? fund.nav, NaN);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return {
      status: 400,
      payload: { error: "Fund price unavailable. Refresh when live pricing is back." },
    };
  }

  const unitsToSell = amountGBP / unitPrice;
  const currentUnits = portfolio.holdings[fundId] || 0;
  if (currentUnits < unitsToSell) {
    return {
      status: 400,
      payload: { error: "Not enough units to sell that amount." },
    };
  }

  portfolio.holdings[fundId] = currentUnits - unitsToSell;
  if (portfolio.holdings[fundId] <= 1e-8) {
    delete portfolio.holdings[fundId];
  }
  portfolio.cashGBP += amountGBP;
  portfolio.transactions.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: "SELL",
    fundId,
    fundName: fund.name,
    amountGBP: Number(amountGBP.toFixed(2)),
    units: Number(unitsToSell.toFixed(6)),
    priceAtTrade: Number(unitPrice.toFixed(2)),
    time: new Date().toISOString(),
  });

  return { status: 200, payload: summarizePortfolio(funds) };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/" && req.method === "GET") {
      const html = fs.readFileSync(FRONTEND_PATH, "utf8");
      sendHtml(res, html);
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, now: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/funds" && req.method === "GET") {
      const forceRefresh = parseBooleanFlag(url.searchParams.get("refresh"));
      const funds = await getAllFunds({ forceRefresh });
      sendJson(res, 200, { funds });
      return;
    }

    if (url.pathname.startsWith("/api/funds/") && req.method === "GET") {
      const fundId = url.pathname.split("/").pop();
      const forceRefresh = parseBooleanFlag(url.searchParams.get("refresh"));
      const funds = await getAllFunds({ forceRefresh });
      const fund = funds.find((f) => f.id === fundId);
      if (!fund) {
        sendJson(res, 404, { error: "Fund not found." });
        return;
      }
      sendJson(res, 200, { fund });
      return;
    }

    if (url.pathname === "/api/cache" && req.method === "GET") {
      const diskCached = readDiskFundsCache();
      const historyDb = getHistoryDbStatus();
      const hasTodaySnapshots = Boolean(
        getDailyFundSnapshots(getFundIds(), new Date().toISOString())?.length
      );
      sendJson(res, 200, {
        file: DISK_CACHE_FILE,
        maxAgeHours: DISK_CACHE_MAX_AGE_HOURS,
        exists: Boolean(diskCached),
        savedAt: diskCached?.savedAt || null,
        fundCount: diskCached?.funds?.length || 0,
        hasTodaySnapshots,
        historyDb,
      });
      return;
    }

    if (url.pathname === "/api/history-db" && req.method === "GET") {
      sendJson(res, 200, getHistoryDbStatus());
      return;
    }

    if (url.pathname === "/api/portfolio" && req.method === "GET") {
      const funds = await getAllFunds();
      sendJson(res, 200, summarizePortfolio(funds));
      return;
    }

    if (url.pathname === "/api/portfolio/buy" && req.method === "POST") {
      const body = await readBody(req);
      const funds = await getAllFunds();
      const result = await handleBuy(body, funds);
      sendJson(res, result.status, result.payload);
      return;
    }

    if (url.pathname === "/api/portfolio/sell" && req.method === "POST") {
      const body = await readBody(req);
      const funds = await getAllFunds();
      const result = await handleSell(body, funds);
      sendJson(res, result.status, result.payload);
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (err) {
    sendJson(res, 500, {
      error: "Internal server error.",
      message: err.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pokemon Index app running at http://${HOST}:${PORT}`);
});
