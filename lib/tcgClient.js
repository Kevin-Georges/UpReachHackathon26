const { TCGAPI, API_KEY } = require("./config");

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

async function fetchCardRecordById(cardId) {
  const j = await fetchJson(`${TCGAPI}/cards/${encodeURIComponent(cardId)}`);
  return j.data || null;
}

module.exports = {
  tcgapiHeaders,
  fetchJson,
  listAllGames,
  resolveGameSlugs,
  slugForGame,
  tcgSearch,
  fetchCardRecordById,
};
