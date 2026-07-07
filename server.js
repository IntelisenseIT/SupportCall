"use strict";
/**
 * SupportCall Alert API — HTTP/SSE transport over the Orchestrator.
 *
 * Zero dependencies (Node >= 20). Run: node server.js
 *
 * Endpoints
 *   POST /api/alerts                 raise an alert (support-system webhook)
 *   GET  /api/alerts?active=1        list alerts
 *   GET  /api/alerts/:id             alert state + full audit trail
 *   POST /api/alerts/:id/accept      { userId }                -> 200 | 409 winner
 *   POST /api/alerts/:id/reject      { userId, reason? }       -> escalates immediately
 *   POST /api/alerts/:id/cancel      { reason? }               -> withdraw from source
 *   GET  /api/policy                 current window + escalation chain
 *   PUT  /api/policy                 { windowSec?, chain? }
 *   GET  /api/events?userId=U001     SSE stream of orchestrator events
 *   GET  /api/health                 liveness + dead-man info
 *   GET  /                           serves ../clients/pwa (demo hosting)
 *
 * Auth: if SUPPORTCALL_API_KEY is set, every /api request must send
 * x-api-key. This is a stub — production replaces it with Entra ID JWT
 * validation (issuer/audience/signature) and per-user identity from claims.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Orchestrator } = require("./orchestrator.js");

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.SUPPORTCALL_API_KEY || null;
const DATA_DIR = path.join(__dirname, "data");
const SNAPSHOT = path.join(DATA_DIR, "state.json");
const CONFIG = path.join(__dirname, "config.json");
const PWA_DIR = path.join(__dirname, "..", "clients", "pwa");

// ---------- orchestrator + persistence ----------

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const sse = new Map(); // userId -> Set<res>; "*" receives everything

const orch = new Orchestrator({
  policy: config.policy,
  emit: (event) => broadcast(event),
});

let saveScheduled = false;
orch.onChange = () => {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SNAPSHOT, JSON.stringify(orch.toJSON(), null, 2));
    } catch (e) {
      console.error("snapshot write failed:", e.message);
    }
  }, 250).unref();
};

if (fs.existsSync(SNAPSHOT)) {
  try {
    orch.restore(JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")));
    console.log("restored state snapshot");
  } catch (e) {
    console.error("snapshot restore failed:", e.message);
  }
}

let lastEventAt = null;
function broadcast(event) {
  lastEventAt = new Date().toISOString();
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const targets = new Set([...(sse.get("*") || []), ...(sse.get(event.userId) || [])]);
  // resolution events go to everyone so other devices cancel their alert UI
  if (["accepted", "cancelled", "exhausted"].includes(event.type)) {
    for (const set of sse.values()) for (const res of set) targets.add(res);
  }
  for (const res of targets) {
    try { res.write(payload); } catch (e) {}
  }
}

// ---------- http plumbing ----------

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64 * 1024) { reject(new Error("Payload too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function fromResult(res, result) {
  if (result.ok) return json(res, 200, result);
  return json(res, result.code || 500, result);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json", ".md": "text/plain" };

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.normalize(path.join(PWA_DIR, rel));
  const inside = file === PWA_DIR || file.startsWith(PWA_DIR + path.sep);
  if (!inside) return json(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

// ---------- routes ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (!p.startsWith("/api")) return serveStatic(res, p);

  if (API_KEY && req.headers["x-api-key"] !== API_KEY)
    return json(res, 401, { error: "Missing or invalid x-api-key" });

  try {
    // SSE device stream
    if (req.method === "GET" && p === "/api/events") {
      const userId = url.searchParams.get("userId") || "*";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ userId, at: new Date().toISOString() })}\n\n`);
      if (!sse.has(userId)) sse.set(userId, new Set());
      sse.get(userId).add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
      ping.unref();
      req.on("close", () => { clearInterval(ping); sse.get(userId)?.delete(res); });
      return;
    }

    if (req.method === "GET" && p === "/api/health") {
      return json(res, 200, {
        status: "ok",
        uptimeSec: Math.round(process.uptime()),
        activeAlerts: orch.listAlerts({ activeOnly: true }).length,
        connectedDevices: [...sse.values()].reduce((n, s) => n + s.size, 0),
        lastEventAt,
        // Dead-man guidance: an external monitor should POST a synthetic
        // alert periodically and page a separate channel if lastEventAt stalls.
      });
    }

    if (req.method === "GET" && p === "/api/users")
      return json(res, 200, { ok: true, users: config.users || [] });

    if (req.method === "GET" && p === "/api/policy")
      return json(res, 200, { ok: true, policy: orch.policy });

    if (req.method === "PUT" && p === "/api/policy") {
      const body = await readBody(req);
      if (body.windowSec) {
        if (!Number.isInteger(body.windowSec) || body.windowSec < 10 || body.windowSec > 3600)
          return json(res, 400, { error: "windowSec must be 10–3600" });
        orch.policy.windowSec = body.windowSec;
      }
      if (body.chain) {
        if (!Array.isArray(body.chain) || !body.chain.length || !body.chain.every((u) => u.userId && u.name))
          return json(res, 400, { error: "chain must be a non-empty array of {userId, name, role}" });
        orch.policy.chain = body.chain;
      }
      orch.onChange();
      return json(res, 200, { ok: true, policy: orch.policy });
    }

    if (req.method === "POST" && p === "/api/alerts") {
      const body = await readBody(req);
      return fromResult(res, orch.createAlert(body));
    }

    if (req.method === "GET" && p === "/api/alerts")
      return json(res, 200, { ok: true, alerts: orch.listAlerts({ activeOnly: url.searchParams.get("active") === "1" }) });

    const m = p.match(/^\/api\/alerts\/([0-9a-f-]{36})(?:\/(accept|reject|cancel))?$/);
    if (m) {
      const [, id, action] = m;
      if (req.method === "GET" && !action) {
        const a = orch.getAlert(id);
        return a ? json(res, 200, { ok: true, alert: a }) : json(res, 404, { error: "Alert not found" });
      }
      if (req.method === "POST" && action) {
        const body = await readBody(req);
        if (action === "accept") return fromResult(res, orch.accept(id, body.userId));
        if (action === "reject") return fromResult(res, orch.reject(id, body.userId, body.reason));
        if (action === "cancel") return fromResult(res, orch.cancel(id, body.reason));
      }
    }

    return json(res, 404, { error: "No such route" });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`SupportCall Alert API listening on http://localhost:${PORT}`);
  console.log(`Auth: ${API_KEY ? "x-api-key required" : "OPEN (set SUPPORTCALL_API_KEY for dev auth; production uses Entra ID)"}`);
  console.log(`Serving PWA from ${PWA_DIR}`);
});

module.exports = { server, orch };
