const path = require("path");
const express = require("express");
const cors = require("cors");
const { PORT } = require("./config");
const { getFundsPayload, ensureFundsLoaded, getFundDetail } = require("./funds");
const { computePortfolio, trade } = require("./portfolio");

const ROOT_DIR = path.join(__dirname, "..");

async function startServer() {
  try {
    await getFundsPayload(true);
  } catch (e) {
    console.warn("Initial /api/funds build failed; first request will retry:", e.message);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(ROOT_DIR));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(ROOT_DIR, "frontend", "index.html"));
  });

  app.get("/frontend.html", (_req, res) => {
    res.redirect(301, "/");
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

module.exports = { startServer };
