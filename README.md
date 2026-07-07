# SupportCall

> Your support system manages the incident. This application makes sure
> someone responds to it.

Out-of-hours incident alert and acknowledgement:
**Alert → Get attention → Accept or Reject → Escalate → Audit**

## Repository layout

```
server/            Alert Orchestrator — runnable reference implementation
  orchestrator.js    Domain core: state machine, server-owned timers,
                     atomic first-accept-wins, escalation, audit trail
  server.js          HTTP + SSE transport, health endpoint, JSON snapshots
  config.json        Seed escalation policy
  test/              14 automated tests (node --test), incl. acceptance race,
                     timeout cascade, chain exhaustion, crash recovery
clients/
  pwa/               Installable mobile PWA (sign-in, biometric app lock,
                     support hours, offline shell)
  desktop/           Windows tray-window simulation (call-style toast,
                     looping audio until action)
docs/
  API.md             REST/SSE contract for the dev team
  PRODUCTION-PLAN.md Phased path to production
```

## Run it

Requires Node >= 20. No dependencies, no build step.

```bash
cd server
npm test          # run the state-machine test suite
npm start         # API on http://localhost:8787, PWA served at /
```

Smoke test in a second terminal:

```bash
curl -X POST localhost:8787/api/alerts -H 'content-type: application/json' \
  -d '{"ticketId":"INC-1","title":"Production down","priority":"P1","queueId":"ERP-OH"}'
```

Watch a device stream: `curl -N 'localhost:8787/api/events?userId=U001'`

### Two-device demo (the acceptance race, live)

With the server running, open http://localhost:8787 in two browser windows.
Sign in as david.chen@company.com in one and sarah.thompson@company.com in
the other (any registered email — see server/config.json). Trigger a P1 from
either device: David's rings first (stage 1). If David rejects or times out,
Sarah's device rings seconds later; if both race to accept, the server
decides atomically and the loser sees who won. Readiness shows
"Alert orchestrator: Connected — server owns timers". Without the server,
the PWA falls back to standalone demo mode automatically.

Dev auth: `SUPPORTCALL_API_KEY=secret npm start` then send `x-api-key: secret`.

## What is production-real vs. reference

Real now: the control model (server owns all timers and escalation — devices
only display and respond), atomic acceptance, idempotent webhook intake,
append-only audit, staged reminders, restart recovery from snapshot,
health endpoint, and the tested state machine.

Reference stand-ins to replace on the Azure build (design document §7/§13):
JSON snapshot → Azure SQL; in-process setTimeout → Service Bus scheduled
messages or Durable Functions; SSE → SignalR + Azure Notification Hubs
(APNs/FCM); x-api-key → Microsoft Entra ID JWT validation. The orchestrator
is written to port 1:1 — accept() maps to a conditional UPDATE, emit() to the
push adapter.

## Non-negotiable design principles (from the design document)

- The support ticket stays in the support system. This app never edits it.
- Delivery is not acknowledgement. Silence escalates.
- First valid acceptance wins, decided centrally and atomically.
- Rejection escalates immediately — never waits for the timer.
- Every transition is audited.
- The absence of alerts must be independently monitored (dead-man switch).
