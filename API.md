# SupportCall Alert API — contract

Base URL: `http://<host>:8787` · All bodies JSON · Auth: `x-api-key` header
when `SUPPORTCALL_API_KEY` is set (dev stub — production replaces this with
Microsoft Entra ID bearer tokens; user identity comes from token claims, not
the request body).

## Raise an alert (support system webhook)

`POST /api/alerts`

```json
{
  "externalId": "evt-1001",
  "ticketId": "INC-10452",
  "title": "Production system unavailable",
  "customer": "ABC Manufacturing",
  "priority": "P1",
  "queueId": "ERP-OH",
  "supportUrl": "https://support.example.com/ticket/INC-10452"
}
```

Required: ticketId, title, priority, queueId. `externalId` makes the webhook
idempotent — a redelivered event returns the existing alert with
`"deduplicated": true` instead of double-alerting.

Response `200`: `{ ok, alert }` — alert is ringing, stage 1 attempt started,
timers armed server-side.

## Respond

`POST /api/alerts/{id}/accept` — `{ "userId": "U002" }`
First valid acceptance wins, processed atomically.
- `200 { ok, alert }` — you are the responder; all devices receive a cancel.
- `409 { error, acceptedBy, acceptedAt }` — lost the race; show
  "already accepted by …".
- `403` — user not in the escalation chain.

`POST /api/alerts/{id}/reject` — `{ "userId": "U001", "reason": "unavailable" }`
Only the currently alerted responder may reject. Escalates to the next stage
immediately — never waits for the timer. Reason optional.

`POST /api/alerts/{id}/cancel` — `{ "reason": "..." }`
Source-system withdrawal (ticket resolved elsewhere). Stops the cascade.

## Query

`GET /api/alerts?active=1` — list (all or ringing only).
`GET /api/alerts/{id}` — full state: status (`ringing | accepted | exhausted |
cancelled`), attempts (stage, target, result, timestamps) and the append-only
`audit` trail.

## Policy

`GET /api/policy` · `PUT /api/policy`
`{ "windowSec": 300, "chain": [{ "userId", "name", "role" }, ...] }`
windowSec 10–3600. Production extends this per customer/contract/queue/
priority/shift per design document section 4.

## Device stream

`GET /api/events?userId=U001` — Server-Sent Events.

| event | meaning |
| --- | --- |
| `ring` | You are the target of a new attempt. Payload: alertId, stage, windowSec, minimal ticket fields (small-payload principle — fetch detail via GET). |
| `reminder` | Staged attention nudge: `second-notice` (20%), `reminder` (40%), `final-warning` (70%). |
| `attempt-closed` | Your attempt ended (rejected/timed out). |
| `accepted` / `cancelled` / `exhausted` | Broadcast to all devices so every client clears its alert UI. |

Production swaps SSE for SignalR (desktop) and APNs/FCM via Azure
Notification Hubs (mobile); the event vocabulary stays the same.

## Health

`GET /api/health` — `{ status, uptimeSec, activeAlerts, connectedDevices,
lastEventAt }`. Dead-man pattern: an external monitor raises a synthetic
alert on a test queue every few minutes and pages a separate channel if the
pipeline stalls (design document section 10).
