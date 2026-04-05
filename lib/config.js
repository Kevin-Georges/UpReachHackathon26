/**
 * Environment and static tuning for the TCG index backend.
 * Load `.env` from the project root in `backend.js` before requiring other `lib/` modules.
 */

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

const HISTORY_MAX_POINTS = 30;

/** Same-day NAV updates below this (GBP) do not rewrite the last history point (stable chart on refresh). */
const MEANINGFUL_NAV_DELTA_GBP = 0.02;

const LOCK_BASKET_SIZE = 42;
const MIN_LOCKED_REFRESH_PRICES = 3;

const INITIAL_CASH = 10_000;

module.exports = {
  TCGAPI: "https://api.tcgapi.dev/v1",
  PORT,
  USD_TO_GBP,
  API_KEY,
  CACHE_MS,
  FUND_META,
  HISTORY_MAX_POINTS,
  MEANINGFUL_NAV_DELTA_GBP,
  LOCK_BASKET_SIZE,
  MIN_LOCKED_REFRESH_PRICES,
  INITIAL_CASH,
};
