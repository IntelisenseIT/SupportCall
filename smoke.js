"use strict";
process.env.PORT = "0";
const { server, orch } = require("../server.js");

server.on("listening", async () => {
  const base = `http://localhost:${server.address().port}`;
  const j = (r) => r.json();
  try {
    const health = await fetch(`${base}/api/health`).then(j);
    console.log("health:", health.status, "| activeAlerts:", health.activeAlerts);

    const payload = {
      externalId: "evt-" + Date.now(), ticketId: "INC-10452", title: "Production system unavailable",
      customer: "ABC Manufacturing", priority: "P1", queueId: "ERP-OH",
    };
    const created = await fetch(`${base}/api/alerts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }).then(j);
    console.log("created:", created.alert.status, "stage1 ->", created.alert.attempts[0].name);

    const redelivered = await fetch(`${base}/api/alerts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }).then(j);
    console.log("redelivered webhook deduplicated:", redelivered.deduplicated === true);

    const id = created.alert.id;
    const accept = (userId) => fetch(`${base}/api/alerts/${id}/accept`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }),
    }).then(j);
    const [r1, r2] = await Promise.all([accept("U001"), accept("U002")]);
    const winner = [r1, r2].find((r) => r.ok);
    const loser = [r1, r2].find((r) => !r.ok);
    console.log("race -> winner:", winner.alert.acceptedBy, "| loser got:", loser.code, "acceptedBy", loser.acceptedBy);

    const full = await fetch(`${base}/api/alerts/${id}`).then(j);
    console.log("audit:");
    for (const e of full.alert.audit) console.log("  ", e.event, "—", e.detail);

    const trav = await fetch(`${base}/..%2f..%2fserver%2fconfig.json`);
    console.log("traversal attempt:", trav.status);
    const pwa = await fetch(`${base}/`);
    const body = await pwa.text();
    console.log("pwa served:", pwa.status, body.includes("SupportCall") ? "(SupportCall index)" : "(unexpected)");
    const mani = await fetch(`${base}/manifest.webmanifest`);
    console.log("manifest:", mani.status);
  } catch (e) {
    console.error("SMOKE FAILED:", e);
    process.exitCode = 1;
  } finally {
    server.close();
    process.exit();
  }
});
