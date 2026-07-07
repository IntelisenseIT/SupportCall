"use strict";
const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const { Orchestrator } = require("../orchestrator.js");

const CHAIN = [
  { userId: "U001", name: "David Chen", role: "primary engineer" },
  { userId: "U002", name: "Sarah Thompson", role: "secondary engineer" },
  { userId: "U003", name: "Marcus Webb", role: "senior support engineer" },
];
const TICKET = { ticketId: "INC-10452", title: "Production system unavailable", customer: "ABC Manufacturing", priority: "P1", queueId: "ERP-OH" };

function makeOrch(events = []) {
  return new Orchestrator({
    policy: { windowSec: 300, chain: structuredClone(CHAIN) },
    emit: (e) => events.push(e),
  });
}

test("creating an alert starts stage 1 and rings the primary engineer", () => {
  const events = [];
  const o = makeOrch(events);
  const res = o.createAlert(TICKET);
  assert.equal(res.ok, true);
  assert.equal(res.alert.status, "ringing");
  assert.equal(res.alert.attempts.length, 1);
  assert.equal(res.alert.attempts[0].userId, "U001");
  assert.equal(events[0].type, "ring");
  assert.equal(events[0].userId, "U001");
  assert.equal(events[0].windowSec, 300);
});

test("rejects malformed payloads", () => {
  const o = makeOrch();
  assert.equal(o.createAlert({ title: "x" }).code, 400);
  assert.equal(o.createAlert({ ...TICKET, priority: 1 }).code, 400);
});

test("duplicate externalId is deduplicated, not double-alerted", () => {
  const o = makeOrch();
  const a = o.createAlert({ ...TICKET, externalId: "evt-1" });
  const b = o.createAlert({ ...TICKET, externalId: "evt-1" });
  assert.equal(b.deduplicated, true);
  assert.equal(a.alert.id, b.alert.id);
  assert.equal(o.listAlerts().length, 1);
});

test("first valid acceptance wins; the second accepter gets 409 with the winner", () => {
  const o = makeOrch();
  const { alert } = o.createAlert(TICKET);
  const first = o.accept(alert.id, "U002");
  const second = o.accept(alert.id, "U001");
  assert.equal(first.ok, true);
  assert.equal(first.alert.acceptedBy, "U002");
  assert.equal(second.ok, false);
  assert.equal(second.code, 409);
  assert.equal(second.acceptedBy, "U002");
  assert.ok(second.acceptedAt);
});

test("users outside the escalation chain cannot accept", () => {
  const o = makeOrch();
  const { alert } = o.createAlert(TICKET);
  const res = o.accept(alert.id, "U999");
  assert.equal(res.code, 403);
  assert.equal(o.getAlert(alert.id).status, "ringing");
});

test("reject escalates immediately without waiting for the timer", () => {
  const events = [];
  const o = makeOrch(events);
  const { alert } = o.createAlert(TICKET);
  const res = o.reject(alert.id, "U001", "unavailable");
  assert.equal(res.ok, true);
  const a = o.getAlert(alert.id);
  assert.equal(a.attempts.length, 2);
  assert.equal(a.attempts[0].result, "rejected:unavailable");
  assert.equal(a.attempts[1].userId, "U002");
  const rings = events.filter((e) => e.type === "ring");
  assert.equal(rings.length, 2);
});

test("only the currently alerted responder can reject", () => {
  const o = makeOrch();
  const { alert } = o.createAlert(TICKET);
  assert.equal(o.reject(alert.id, "U003").code, 403);
});

test("timeout closes the attempt and escalates to the next stage", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const o = makeOrch(events);
  const { alert } = o.createAlert(TICKET);
  t.mock.timers.tick(300 * 1000);
  const a = o.getAlert(alert.id);
  assert.equal(a.attempts[0].result, "timed-out");
  assert.equal(a.attempts[1].userId, "U002");
  assert.equal(a.status, "ringing");
});

test("staged reminders fire at 20/40/70 percent of the window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const o = makeOrch(events);
  o.createAlert(TICKET);
  t.mock.timers.tick(0.2 * 300 * 1000);
  t.mock.timers.tick(0.2 * 300 * 1000);
  t.mock.timers.tick(0.3 * 300 * 1000);
  const labels = events.filter((e) => e.type === "reminder").map((e) => e.label);
  assert.deepEqual(labels, ["second-notice", "reminder", "final-warning"]);
});

test("acceptance stops all pending reminders and the timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const o = makeOrch(events);
  const { alert } = o.createAlert(TICKET);
  o.accept(alert.id, "U001");
  t.mock.timers.tick(400 * 1000);
  assert.equal(events.filter((e) => e.type === "reminder").length, 0);
  assert.equal(o.getAlert(alert.id).attempts.length, 1);
});

test("a fully unresponsive chain exhausts to the emergency fallback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const o = makeOrch(events);
  const { alert } = o.createAlert(TICKET);
  for (let i = 0; i < CHAIN.length; i++) t.mock.timers.tick(300 * 1000);
  const a = o.getAlert(alert.id);
  assert.equal(a.status, "exhausted");
  assert.equal(a.attempts.length, 3);
  assert.ok(a.attempts.every((x) => x.result === "timed-out"));
  assert.equal(events.at(-1).type, "exhausted");
});

test("cancel withdraws a ringing alert and stops the cascade", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const o = makeOrch();
  const { alert } = o.createAlert(TICKET);
  o.cancel(alert.id, "Ticket resolved in support system");
  t.mock.timers.tick(600 * 1000);
  const a = o.getAlert(alert.id);
  assert.equal(a.status, "cancelled");
  assert.equal(a.attempts.length, 1);
});

test("audit trail records the complete lifecycle in order", () => {
  const o = makeOrch();
  const { alert } = o.createAlert(TICKET);
  o.reject(alert.id, "U001", "unavailable");
  o.accept(alert.id, "U002");
  const evs = o.getAlert(alert.id).audit.map((e) => e.event);
  assert.deepEqual(evs, [
    "alert.created",
    "attempt.started",
    "attempt.rejected",
    "attempt.started",
    "alert.accepted",
    "alert.broadcast-cancel",
  ]);
});

test("restore re-arms timers so a restart does not lose a ringing alert", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const o1 = makeOrch();
  const { alert } = o1.createAlert(TICKET);
  const snapshot = JSON.parse(JSON.stringify(o1.toJSON()));
  // simulate crash: new orchestrator, restore, then let the window elapse
  const events = [];
  const o2 = new Orchestrator({ policy: snapshot.policy, emit: (e) => events.push(e) });
  o2.restore(snapshot);
  t.mock.timers.tick(300 * 1000);
  const a = o2.getAlert(alert.id);
  assert.equal(a.attempts[0].result, "timed-out");
  assert.equal(a.attempts[1].userId, "U002");
  assert.ok(a.audit.some((e) => e.event === "orchestrator.recovered"));
});
