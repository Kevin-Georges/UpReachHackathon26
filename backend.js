/**
 * Backend: index-fund JSON for frontend/ app using TCG API (https://tcgapi.dev/)
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
 *
 * Implementation lives under `lib/` (config, TCG client, pricing, history, funds, portfolio, HTTP server).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { startServer } = require("./lib/server");

startServer().catch((e) => {
  console.error(e);
  process.exit(1);
});
