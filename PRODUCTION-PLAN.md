# Path to production

Phase 0 (done): UX prototypes (PWA + desktop), tested orchestrator reference
implementation with the API contract in docs/API.md.

Phase 1 — Core service on Azure (the real MVP)
- Port orchestrator.js to ASP.NET Core: entities in Azure SQL (design doc
  §14), accept() as conditional UPDATE (first-accept-wins), timers as
  Service Bus scheduled messages or Durable Functions.
- Entra ID auth: MSAL in clients, JWT validation in the API; device
  registrations bound to immutable User IDs (§5).
- Integration API + Service Bus intake from the support system, idempotent
  on event id; OData enrichment of ticket display fields (§8).
- Application Insights tracing per alert; health + dead-man synthetic alert
  loop with an independent external monitor (§10).

Phase 2 — Native clients
- .NET MAUI iOS/Android: APNs/FCM via Azure Notification Hubs, small
  payloads, graceful degradation ladder on Android 13–15 (§11).
- Apply early for the Apple Critical Alerts entitlement; design so the
  product works without it.
- Windows tray app: toast incoming-call scenario (looping audio), SignalR
  live state (§12). Keep the PWA as secondary/desk channel.
- Keep the biometric-verification-to-accept pattern and its audit line.

Phase 3 — Prove and cut over
- 2–4 weeks shadow mode alongside the existing out-of-hours process.
- Chaos drills: kill orchestrator mid-window, revoke push token, dual
  accept, support system offline — verify each matches §10's designed
  outcomes.
- Pen test, Key Vault for secrets, audit retention policy, runbook for
  "the alerting system is down". Cut over one queue/contract at a time.

Phase 4 — §15 later enhancements (rota management, swaps, Teams/SMS/
telephony fallback, per-customer escalation, dashboards).
