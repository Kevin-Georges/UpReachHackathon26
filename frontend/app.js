const PAGE_KEYS = [
  "dashboard",
  "marketplace",
  "fund-explorer",
  "era-funds",
  "basket-builder",
  "price-history",
  "paper-trading",
  "portfolio",
];
const DEFAULT_PAGE = "marketplace";

/** Root-relative paths so icons load from the dev server regardless of hash routes. */
const ASSET_BASE = "/assets/";

/** Fund row logos: filenames must exist under `assets/` (see repo `assets/`). */
const FUND_ICON_FILES = {
  "poke-global": "pokeball.svg",
  "mtg-index": "mtg.svg",
  "yugioh-index": "yugioh.svg",
};

/** Preferred API base before we discover a working one (same-origin on :3847, else points at Node). */
function resolveApiBase() {
  try {
    const q = new URLSearchParams(window.location.search).get("api");
    if (q) return q.replace(/\/$/, "");
  } catch (_e) {}
  const { protocol, hostname, port } = window.location;
  if (protocol === "file:") return "http://127.0.0.1:4010";
  const p = String(port || "");
  if (p === "4010") return "";
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    if (p === "" || p === "80" || p === "8080" || p === "443") return "http://127.0.0.1:4010";
  }
  return "";
}

function collectApiBases() {
  const list = [];
  const seen = new Set();
  const push = (b) => {
    const v = b == null ? "" : String(b).replace(/\/$/, "");
    if (seen.has(v)) return;
    seen.add(v);
    list.push(v);
  };
  try {
    const q = new URLSearchParams(window.location.search).get("api");
    if (q) push(q.trim());
  } catch (_e) {}
  push(resolveApiBase());
  push("");
  push("http://127.0.0.1:4010");
  push("http://localhost:4010");
  return list;
}

function abortAfter(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

/** Cold `/api/funds` can take minutes (many set fetches + TCG). 8s caused empty UI / "failed". */
const FUNDS_FETCH_TIMEOUT_MS = 180000;

let __apiBase = null;

const state = {
  funds: [],
  selectedFundId: null,
  selectedFund: null,
  portfolio: null,
  chartPoints: [],
  historyChartPoints: [],
  activePage: DEFAULT_PAGE,
  /** ISO timestamp from server `GET /api/funds` when connected to backend */
  lastFundsUpdated: null,
};

const api = {
  resetConnection() {
    __apiBase = null;
  },
  async _ensureBackendPath(path, init = {}) {
    if (__apiBase === null) throw new Error("No API base");
    const res = await fetch(`${__apiBase}${path}`, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.error || data.message || res.statusText;
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return data;
  },
  async getFunds(forceRefresh = false) {
    if (forceRefresh && __apiBase !== null) {
      try {
        return await this._ensureBackendPath(`/api/funds?refresh=1`);
      } catch (_e) {
        this.resetConnection();
      }
    } else if (forceRefresh) {
      this.resetConnection();
    }

    const qs = forceRefresh ? "?refresh=1" : "";
    const path = `/api/funds${qs}`;
    if (__apiBase !== null) {
      try {
        return await this._ensureBackendPath(path);
      } catch (_e) {
        this.resetConnection();
      }
    }
    const errors = [];
    for (const base of collectApiBases()) {
      const { signal, clear } = abortAfter(FUNDS_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}${path}`, { signal });
        clear();
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          __apiBase = base;
          return data;
        }
        errors.push(`${base || "(same origin)"}: HTTP ${res.status} ${data.error || res.statusText}`);
      } catch (e) {
        clear();
        errors.push(`${base || "(same origin)"}: ${e.message || "failed"}`);
      }
    }
    __apiBase = null;
    throw new Error(
      `Cannot load funds from the API. ${errors[0] || "Check that node backend.js is running and TCGAPI_KEY is set."}`
    );
  },
  async getFund(id) {
    if (__apiBase === null) await this.getFunds(false);
    return this._ensureBackendPath(`/api/funds/${encodeURIComponent(id)}`);
  },
  async getPortfolio() {
    if (__apiBase === null) await this.getFunds(false);
    return this._ensureBackendPath("/api/portfolio");
  },
  async trade(type, payload) {
    if (__apiBase === null) await this.getFunds(false);
    return this._ensureBackendPath(`/api/portfolio/${encodeURIComponent(type)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
};

let fmtMoney = (n) =>
  `£${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const fmtPct = (n) =>
  `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
fmtMoney = (n) =>
  `\u00A3${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

function getCurrentPrice(fund) {
  const price = Number(fund?.priceGBP ?? fund?.blendedPriceGBP ?? fund?.nav ?? 0);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function normalizeFundName(name) {
  return String(name || "")
    .replace(/\bETF\b/gi, "Index")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeDisplayText(text) {
  return String(text || "")
    .replace(/\bETF-style\b/gi, "index-style")
    .replace(/\bETF\b/gi, "Index")
    .replace(/\betf\b/g, "index")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizePageKey(value) {
  return PAGE_KEYS.includes(String(value || "")) ? String(value) : DEFAULT_PAGE;
}

function getPageFromHash() {
  return normalizePageKey(String(window.location.hash || "").replace(/^#/, ""));
}

function setActivePage(pageKey, updateHash = true) {
  const page = normalizePageKey(pageKey);
  state.activePage = page;

  for (const view of document.querySelectorAll(".app-page")) {
    view.classList.toggle("active", view.id === `page-${page}`);
  }
  for (const tab of document.querySelectorAll(".nav-pill[data-page]")) {
    tab.classList.toggle("active", tab.getAttribute("data-page") === page);
  }

  if (updateHash) {
    const nextHash = `#${page}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }

  if (page === "price-history") {
    drawHistoryPageChart();
  }
}

function setFundSelectOptions(selectIds) {
  for (const id of selectIds) {
    const select = document.getElementById(id);
    if (!select) continue;
    const oldValue = select.value;
    select.innerHTML = state.funds
      .map((f) => `<option value="${f.id}">${normalizeFundName(f.name)}</option>`)
      .join("");
    const targetValue = state.selectedFundId || oldValue || state.funds[0]?.id || "";
    if (targetValue) {
      select.value = targetValue;
    }
  }
}

function toast(message, isError = false) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function renderTopStats() {
  const p = state.portfolio;
  const container = document.getElementById("topStats");
  if (!p || !container) return;
  const cards = [
    { label: "Total Portfolio", value: fmtMoney(p.totalValueGBP), cls: "" },
    { label: "Cash", value: fmtMoney(p.cashGBP), cls: "" },
    {
      label: "PnL",
      value: `${fmtMoney(p.pnlGBP)} (${fmtPct(p.pnlPct)})`,
      cls: p.pnlGBP >= 0 ? "good" : "bad",
    },
  ];
  container.innerHTML = cards
    .map(
      (c) => `
      <article class="stat-card">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value ${c.cls}">${c.value}</div>
      </article>
    `
    )
    .join("");
}

function renderFunds() {
    const renderRows = (targetId, funds, destinationPage = null) => {
  const body = document.getElementById(targetId);
  if (!body) return;

  body.innerHTML = funds
  .map((f) => {
    const changeClass = f.dayChangePct >= 0 ? "good" : "bad";
    const selected = state.selectedFundId === f.id;

    const iconFile = FUND_ICON_FILES[f.id] || "cardex.svg";

    const iconSrc = `${ASSET_BASE}${iconFile}`;
    const fallbackSrc = `${ASSET_BASE}cardex.svg`;
          return `
          <tr data-fund-id="${f.id}" class="${selected ? "selected-fund" : ""}">
            <td>
              <div style="display: flex; align-items: center; gap: 12px;">
                <img src="${iconSrc}" class="game-icon" alt="" data-fund-icon="${f.id}" onerror="this.onerror=null;this.src='${fallbackSrc}'">
                <div>
                  <strong>${normalizeFundName(f.name)}</strong><br />
                  <span class="fund-description">${normalizeDisplayText(f.description || "")}</span>
                </div>
              </div>
            </td>
            <td>${String(f.type || "").toUpperCase()}</td>
            <td>${fmtMoney(getCurrentPrice(f))}</td>
            <td class="${changeClass}">${fmtPct(f.dayChangePct)}</td>
          </tr>
        `;
      })
      .join("");

  for (const tr of body.querySelectorAll("tr[data-fund-id]")) {
      tr.addEventListener("click", async () => {
          state.selectedFundId = tr.getAttribute("data-fund-id");
          await loadSelectedFund();
          renderFunds();
          if (destinationPage) setActivePage(destinationPage);
      });
  }
    };

    renderRows("fundRows", state.funds);
    renderRows("dashboardFundRows", state.funds, "fund-explorer");
    setFundSelectOptions(["tradeFund", "explorerFund", "builderFund", "historyFund"]);
}

function renderFundsLastUpdatedLine() {
  const el = document.getElementById("fundsLastUpdatedLine");
  if (!el) return;
  if (!state.lastFundsUpdated) {
    el.textContent = "";
    return;
  }
  const d = new Date(state.lastFundsUpdated);
  if (Number.isNaN(d.getTime())) {
    el.textContent = "";
    return;
  }
  el.textContent = `Last rebuilt on server: ${d.toLocaleString()}`;
}

function renderPortfolio() {
  const p = state.portfolio;
  if (!p) return;
  const summaryMarkup = `
    <tr><th>Cash</th><td>${fmtMoney(p.cashGBP)}</td></tr>
    <tr><th>Holdings Value</th><td>${fmtMoney(p.holdingsValueGBP)}</td></tr>
    <tr><th>Total Value</th><td>${fmtMoney(p.totalValueGBP)}</td></tr>
    <tr><th>Net Invested</th><td>${fmtMoney(p.netInvestedGBP)}</td></tr>
  `;

  const positionsMarkup =
    p.positions.length === 0
      ? `<tr><td colspan="4" style="color:#6b7280;">No positions yet.</td></tr>`
      : p.positions
          .map(
            (pos) => `
              <tr>
                <td>${normalizeFundName(pos.fundName)}</td>
                <td>${pos.units.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                <td>${fmtMoney(pos.priceGBP ?? pos.nav)}</td>
                <td>${fmtMoney(pos.marketValueGBP)}</td>
              </tr>
            `
          )
          .join("");

  const portfolioStats = document.getElementById("portfolioStats");
  if (portfolioStats) portfolioStats.innerHTML = summaryMarkup;

  const positionsRows = document.getElementById("positionsRows");
  if (positionsRows) positionsRows.innerHTML = positionsMarkup;

  const portfolioSummaryRows = document.getElementById("portfolioSummaryRows");
  if (portfolioSummaryRows) {
    portfolioSummaryRows.innerHTML =
      summaryMarkup +
      `<tr><th>PnL</th><td class="${p.pnlGBP >= 0 ? "good" : "bad"}">${fmtMoney(
        p.pnlGBP
      )} (${fmtPct(p.pnlPct)})</td></tr>`;
  }

  const portfolioPagePositionsRows = document.getElementById("portfolioPagePositionsRows");
  if (portfolioPagePositionsRows) portfolioPagePositionsRows.innerHTML = positionsMarkup;

  const tradeHistoryRows = document.getElementById("tradeHistoryRows");
  if (tradeHistoryRows) {
    const txs = Array.isArray(p.transactions) ? p.transactions : [];
    tradeHistoryRows.innerHTML =
      txs.length === 0
        ? `<tr><td colspan="6" style="color:#6b7280;">No trades yet.</td></tr>`
        : txs
            .map((tx) => {
              const price = Number(tx.priceAtTrade ?? tx.navAtTrade ?? 0);
              return `
                <tr>
                  <td>${new Date(tx.time).toLocaleString()}</td>
                  <td>${tx.type}</td>
                  <td>${normalizeFundName(tx.fundName)}</td>
                  <td>${fmtMoney(tx.amountGBP)}</td>
                  <td>${Number(tx.units || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                  <td>${fmtMoney(price)}</td>
                </tr>
              `;
            })
            .join("");
  }
}

function cardWeightShareGBP(c) {
  const price = Number(c.priceGBP || 0);
  const w = Number(c.contribution || 0);
  return price * (w / 100);
}

function renderCardWeightsTable(tbodyId, fund, limit = 60) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (!fund || !Array.isArray(fund.constituents) || fund.constituents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:#6b7280;">No basket data.</td></tr>`;
    return;
  }
  const slice = fund.constituents.slice(0, limit);
  const maxW = Math.max(...slice.map((c) => Number(c.contribution) || 0), 0.001);
  let sumPct = 0;
  let sumGbp = 0;
  const lines = slice.map((c) => {
    const pct = Number(c.contribution) || 0;
    const gbp = cardWeightShareGBP(c);
    sumPct += pct;
    sumGbp += gbp;
    const barPct = Math.min(100, (pct / maxW) * 100);
    return `
      <tr>
        <td>${c.name} #${c.number}</td>
        <td>${pct.toFixed(3)}%</td>
        <td>${fmtMoney(gbp)}</td>
        <td>
          <div class="weight-bar-track" title="${pct.toFixed(3)}% of basket">
            <div class="weight-bar-fill" style="width:${barPct}%;"></div>
          </div>
        </td>
      </tr>
    `;
  });
  const subtotalRow = `
    <tr>
      <th>Subtotal (${slice.length} cards shown)</th>
      <td>${sumPct.toFixed(3)}%</td>
      <td>${fmtMoney(sumGbp)}</td>
      <td></td>
    </tr>
  `;
  tbody.innerHTML = lines.join("") + subtotalRow;
}

function renderConstituents() {
  const fund = state.selectedFund;
  const rows = document.getElementById("constituentsRows");
  if (!rows) return;
  if (!fund || !Array.isArray(fund.constituents)) {
    rows.innerHTML = "";
    renderCardWeightsTable("marketplaceWeightRows", null, 60);
    return;
  }
  rows.innerHTML = fund.constituents
    .slice(0, 60)
    .map(
      (c) => `
      <tr>
        <td>${c.name} #${c.number}</td>
        <td>${c.setName}</td>
        <td>${c.rarity}</td>
        <td>${fmtMoney(c.priceGBP)}</td>
        <td>${Number(c.contribution).toFixed(3)}%</td>
      </tr>
    `
    )
    .join("");
  renderCardWeightsTable("marketplaceWeightRows", fund, 60);
}

function renderFundStatus() {
  const fund = state.selectedFund;
  const panel = document.getElementById("chart")?.parentElement || null;
  const existing = document.getElementById("fundStatus");
  if (existing) existing.remove();
  if (!fund?.warning || !panel) return;
  const el = document.createElement("div");
  el.id = "fundStatus";
  el.style.marginTop = "8px";
  el.style.fontFamily = "'Segoe UI', sans-serif";
  el.style.fontSize = "12px";
  el.style.fontWeight = "700";
  el.style.color = "#7f1d1d";
  el.textContent = fund.warning;
  panel.appendChild(el);
}

function fmtDate(isoDate) {
  const s = String(isoDate || "");
  if (!s) return "";
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getChartTooltip() {
  let tip = document.getElementById("chartTooltip");
  if (tip) return tip;
  const panel = document.getElementById("chart")?.parentElement || null;
  if (!panel) return null;
  tip = document.createElement("div");
  tip.id = "chartTooltip";
  tip.className = "chart-tooltip";
  panel.appendChild(tip);
  return tip;
}

function hideChartTooltip() {
  const tip = document.getElementById("chartTooltip");
  if (!tip) return;
  tip.style.display = "none";
}

function getHistoryChartTooltip() {
  let tip = document.getElementById("historyChartTooltip");
  if (tip) return tip;
  const panel = document.getElementById("historyChart")?.parentElement || null;
  if (!panel) return null;
  tip = document.createElement("div");
  tip.id = "historyChartTooltip";
  tip.className = "chart-tooltip";
  panel.appendChild(tip);
  return tip;
}

function hideHistoryChartTooltip() {
  const tip = document.getElementById("historyChartTooltip");
  if (!tip) return;
  tip.style.display = "none";
}

function handleChartHover(event) {
  const points = Array.isArray(state.chartPoints) ? state.chartPoints : [];
  if (!points.length) {
    hideChartTooltip();
    return;
  }

  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    hideChartTooltip();
    return;
  }

  const scaleX = canvas.width / rect.width;
  const mouseX = (event.clientX - rect.left) * scaleX;

  let nearest = points[0];
  let bestDist = Math.abs(points[0].x - mouseX);
  for (const point of points) {
    const dist = Math.abs(point.x - mouseX);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = point;
    }
  }

  const tip = getChartTooltip();
  if (!tip) return;
  tip.textContent = `${fmtDate(nearest.date)} | Price ${fmtMoney(nearest.price)}`;
  tip.style.display = "block";

  const xCss = nearest.x / scaleX;
  const maxLeft = rect.width - tip.offsetWidth - 8;
  const left = Math.max(8, Math.min(xCss + 10, Math.max(8, maxLeft)));
  tip.style.left = `${left}px`;
}

function handleHistoryChartHover(event) {
  const points = Array.isArray(state.historyChartPoints) ? state.historyChartPoints : [];
  if (!points.length) {
    hideHistoryChartTooltip();
    return;
  }

  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    hideHistoryChartTooltip();
    return;
  }

  const scaleX = canvas.width / rect.width;
  const mouseX = (event.clientX - rect.left) * scaleX;

  let nearest = points[0];
  let bestDist = Math.abs(points[0].x - mouseX);
  for (const point of points) {
    const dist = Math.abs(point.x - mouseX);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = point;
    }
  }

  const tip = getHistoryChartTooltip();
  if (!tip) return;
  tip.textContent = `${fmtDate(nearest.date)} | Price ${fmtMoney(nearest.price)}`;
  tip.style.display = "block";

  const xCss = nearest.x / scaleX;
  const maxLeft = rect.width - tip.offsetWidth - 8;
  const left = Math.max(8, Math.min(xCss + 10, Math.max(8, maxLeft)));
  tip.style.left = `${left}px`;
}

function getFundSeries(fund) {
  const historySource = Array.isArray(fund?.history) ? fund.history : [];
  let series = historySource
    .map((p) => ({
      date: String(p?.date || "").slice(0, 10),
      price: Number(p?.price ?? p?.nav),
    }))
    .filter((p) => p.date && Number.isFinite(p.price) && p.price > 0);
  if (series.length === 0) {
    const fallbackPrice = getCurrentPrice(fund);
    if (fallbackPrice > 0) {
      series = [{ date: new Date().toISOString().slice(0, 10), price: fallbackPrice }];
    }
  }
  if (series.length === 1) {
    const d = new Date(`${series[0].date}T00:00:00`);
    d.setDate(d.getDate() - 1);
    series = [{ date: d.toISOString().slice(0, 10), price: series[0].price }, series[0]];
  }
  return series;
}

function drawFundChart(canvasId, titleSuffix, interactive = false) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const fund = state.selectedFund;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (interactive) {
    state.chartPoints = [];
  } else if (canvasId === "historyChart") {
    state.historyChartPoints = [];
  }
  if (!fund) return;
  const series = getFundSeries(fund);
  if (!series.length) return;

  const data = series.map((p) => p.price);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const isFlat = Math.abs(max - min) < 1e-9;
  const pad = 30;
  const w = canvas.width - pad * 2;
  const h = canvas.height - pad * 2;

  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad + (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(pad + w, y);
    ctx.stroke();
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "rgba(0,0,0,0.24)");
  gradient.addColorStop(1, "rgba(0,0,0,0.03)");

  const points = data.map((value, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * w;
    const y = isFlat
      ? pad + h * 0.5
      : pad + ((max - value) / Math.max(max - min, 1)) * h;
    return { x, y, price: value, date: series[i]?.date || "" };
  });
  if (interactive) {
    state.chartPoints = points;
  } else if (canvasId === "historyChart") {
    state.historyChartPoints = points;
  }

  ctx.beginPath();
  points.forEach((pt, i) => {
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.lineTo(pad + w, pad + h);
  ctx.lineTo(pad, pad + h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((pt, i) => {
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const current = getCurrentPrice(fund) || data[data.length - 1];
  ctx.fillStyle = "#000";
  ctx.font = "bold 14px 'Avenir Next', sans-serif";
  ctx.fillText(`${normalizeFundName(fund.name)} ${titleSuffix}: ${fmtMoney(current)}`, pad, 20);
}

function drawChart() {
  drawFundChart("chart", "Price", true);
}

function drawHistoryPageChart() {
  drawFundChart("historyChart", "History", false);
}

function renderExplorer() {
  const fund = state.selectedFund;
  const metaRows = document.getElementById("explorerMetaRows");
  const rows = document.getElementById("explorerConstituentsRows");
  if (!metaRows || !rows) return;
  if (!fund) {
    metaRows.innerHTML = "";
    rows.innerHTML = "";
    renderCardWeightsTable("explorerWeightRows", null, 120);
    return;
  }

  const rebuilt = state.lastFundsUpdated
    ? new Date(state.lastFundsUpdated).toLocaleString()
    : "—";
  metaRows.innerHTML = `
    <tr><th>Name</th><td>${normalizeFundName(fund.name)}</td></tr>
    <tr><th>Type</th><td>${String(fund.type || "").toUpperCase()}</td></tr>
    <tr><th>Index Price</th><td>${fmtMoney(getCurrentPrice(fund))}</td></tr>
    <tr><th>Daily Change</th><td class="${Number(fund.dayChangePct) >= 0 ? "good" : "bad"}">${fmtPct(
    fund.dayChangePct
  )}</td></tr>
    <tr><th>Cards</th><td>${Array.isArray(fund.constituents) ? fund.constituents.length : 0}</td></tr>
    <tr><th>History Points</th><td>${getFundSeries(fund).length}</td></tr>
    <tr><th>Last rebuilt (server)</th><td>${rebuilt}</td></tr>
  `;

  renderCardWeightsTable("explorerWeightRows", fund, 120);

  rows.innerHTML = (Array.isArray(fund.constituents) ? fund.constituents : [])
    .slice(0, 120)
    .map(
      (c) => `
        <tr>
          <td>${c.name} #${c.number}</td>
          <td>${c.setName}</td>
          <td>${fmtMoney(c.priceGBP)}</td>
          <td>${Number(c.contribution || 0).toFixed(3)}%</td>
        </tr>
      `
    )
    .join("");
}

function renderBuilder() {
  const fund = state.selectedFund;
  const rows = document.getElementById("builderSetRows");
  if (!rows) return;
  if (!fund || !Array.isArray(fund.constituents) || fund.constituents.length === 0) {
    rows.innerHTML = `<tr><td colspan="4" style="color:#6b7280;">No basket data available.</td></tr>`;
    return;
  }

  const grouped = new Map();
  for (const card of fund.constituents) {
    const setName = String(card.setName || card.setId || "Unknown Set");
    const contribution = Number(card.contribution || 0);
    const price = Number(card.priceGBP || 0);
    const weightedValue = price * (contribution / 100);
    if (!grouped.has(setName)) {
      grouped.set(setName, {
        setName,
        cards: 0,
        contribution: 0,
        weightedValue: 0,
      });
    }
    const row = grouped.get(setName);
    row.cards += 1;
    row.contribution += contribution;
    row.weightedValue += weightedValue;
  }

  const lines = Array.from(grouped.values()).sort(
    (a, b) => b.contribution - a.contribution
  );
  const totalContribution = lines.reduce((sum, row) => sum + row.contribution, 0);
  const totalWeightedValue = lines.reduce((sum, row) => sum + row.weightedValue, 0);

  rows.innerHTML =
    lines
      .map(
        (row) => `
          <tr>
            <td>${row.setName}</td>
            <td>${row.cards}</td>
            <td>${row.contribution.toFixed(3)}%</td>
            <td>${fmtMoney(row.weightedValue)}</td>
          </tr>
        `
      )
      .join("") +
    `
      <tr>
        <th>Total</th>
        <th>${lines.reduce((sum, row) => sum + row.cards, 0)}</th>
        <th>${totalContribution.toFixed(3)}%</th>
        <th>${fmtMoney(totalWeightedValue)}</th>
      </tr>
    `;
}

async function loadSelectedFund() {
  if (!state.selectedFundId) return;
  const res = await api.getFund(state.selectedFundId);
  const fund = res.fund != null ? res.fund : res;
  if (res.lastUpdated) {
    state.lastFundsUpdated = res.lastUpdated;
    renderFundsLastUpdatedLine();
  }
  state.selectedFund = {
    ...fund,
    name: normalizeFundName(fund?.name),
    description: normalizeDisplayText(fund?.description || ""),
  };
  renderConstituents();
  drawChart();
  drawHistoryPageChart();
  renderExplorer();
  renderBuilder();
  renderFundStatus();
}

async function refreshAll(forceRefresh = false) {
  let fundsPayload = null;
  let portfolioData = null;

  try {
    fundsPayload = await api.getFunds(forceRefresh);
    state.funds = (fundsPayload.funds || []).map((fund) => ({
      ...fund,
      name: normalizeFundName(fund?.name),
      description: normalizeDisplayText(fund?.description || ""),
    }));
    state.lastFundsUpdated = fundsPayload.lastUpdated ?? null;
  } catch (err) {
    state.funds = [];
    state.lastFundsUpdated = null;
    state.selectedFundId = null;
    state.selectedFund = null;
    throw err;
  }

  try {
    portfolioData = await api.getPortfolio();
    state.portfolio = portfolioData;
  } catch (_err) {
    state.portfolio = {
      cashGBP: 0,
      holdingsValueGBP: 0,
      totalValueGBP: 0,
      netInvestedGBP: 0,
      pnlGBP: 0,
      pnlPct: 0,
      positions: [],
      transactions: [],
    };
    toast("Portfolio endpoint unavailable, showing funds only.", true);
  }

  const funds = state.funds;
  if (!state.selectedFundId && funds.length) {
    state.selectedFundId = funds[0].id;
  }
  if (state.selectedFundId && !funds.some((f) => f.id === state.selectedFundId)) {
    state.selectedFundId = funds[0]?.id || null;
  }
  if (state.selectedFundId) {
    try {
      await loadSelectedFund();
    } catch (e) {
      toast(String(e.message || e), true);
      state.selectedFund = null;
    }
  }
  renderFunds();
  renderPortfolio();
  renderTopStats();
  renderFundsLastUpdatedLine();
}

async function trade(type) {
  const fundId = document.getElementById("tradeFund").value;
  const amountGBP = Number(document.getElementById("tradeAmount").value);
  if (!fundId || !amountGBP || amountGBP <= 0) {
    toast("Enter a valid fund and amount.", true);
    return;
  }
  try {
    state.portfolio = await api.trade(type, { fundId, amountGBP });
    renderPortfolio();
    renderTopStats();
    toast(`${type.toUpperCase()} executed successfully.`);
  } catch (err) {
    toast(err.message, true);
  }
}

function bindFundSelector(id) {
  const select = document.getElementById(id);
  if (!select) return;
  select.addEventListener("change", async (e) => {
    const fundId = e.target.value;
    if (!fundId) return;
    state.selectedFundId = fundId;
    await loadSelectedFund();
    renderFunds();
  });
}

function bindNavigation() {
  for (const link of document.querySelectorAll("[data-page]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const page = link.getAttribute("data-page");
      setActivePage(page);
    });
  }
  window.addEventListener("hashchange", () => {
    setActivePage(getPageFromHash(), false);
  });
}

const LIVE_REFRESH_BTN_IDS = [
  "refreshBtn",
  "refreshLiveMarketplaceBtn",
  "refreshLiveDashboardBtn",
  "refreshLiveExplorerBtn",
];

function setLiveRefreshBusy(busy) {
  for (const id of LIVE_REFRESH_BTN_IDS) {
    const el = document.getElementById(id);
    if (el) el.disabled = !!busy;
  }
}

async function refreshLiveFromTcgApi() {
  setLiveRefreshBusy(true);
  toast("Fetching latest prices from TCG API (via backend)…");
  try {
    await refreshAll(true);
    toast("Live prices updated from API.");
  } catch (err) {
    toast(err.message || "Refresh failed", true);
  } finally {
    setLiveRefreshBusy(false);
  }
}

bindNavigation();
bindFundSelector("tradeFund");
bindFundSelector("explorerFund");
bindFundSelector("builderFund");
bindFundSelector("historyFund");

document.getElementById("buyBtn")?.addEventListener("click", () => trade("buy"));
document.getElementById("sellBtn")?.addEventListener("click", () => trade("sell"));
document.getElementById("chart")?.addEventListener("mousemove", handleChartHover);
document.getElementById("chart")?.addEventListener("mouseleave", hideChartTooltip);
document
  .getElementById("historyChart")
  ?.addEventListener("mousemove", handleHistoryChartHover);
document
  .getElementById("historyChart")
  ?.addEventListener("mouseleave", hideHistoryChartTooltip);
for (const id of LIVE_REFRESH_BTN_IDS) {
  document.getElementById(id)?.addEventListener("click", () => refreshLiveFromTcgApi());
}

document
  .getElementById("openMarketplaceTradeBtn")
  ?.addEventListener("click", () => setActivePage("marketplace"));

(async function init() {
  try {
    setActivePage(getPageFromHash(), false);
    await refreshAll();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:22px;font-family:Segoe UI,sans-serif;max-width:640px;"><h2>Failed to load app</h2><p>${err.message}</p><p>Run <code>node backend.js</code>, set <code>TCGAPI_KEY</code> in <code>.env</code>, open <code>http://127.0.0.1:4010/</code> (or <code>?api=http://127.0.0.1:4010</code> with XAMPP). The first <code>/api/funds</code> load can take 1–2 minutes (many API calls). If you see rate limit errors, wait until midnight UTC or use a fresh TCG API key.</p></div>`;
  }
})();
