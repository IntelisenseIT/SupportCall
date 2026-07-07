"use strict";
/**
 * SupportCall Alert Orchestrator — domain core.
 *
 * Owns the alert lifecycle end to end. Devices never run timers; they only
 * display state and send accept/reject. This module is transport-agnostic:
 * server.js exposes it over HTTP/SSE, tests drive it directly.
 *
 * Lifecycle:  ringing -> accepted | exhausted | cancelled
 * Every state transition appends to an immutable audit trail.
 *
 * Reference implementation notes for the .NET port:
 * - Single-threaded event loop makes check-and-set atomic here. In ASP.NET
 *   Core + Azure SQL, implement accept() as a conditional UPDATE
 *   (WHERE AcceptedByUserId IS NULL) and treat rowcount 0 as the lost race.
 * - setTimeout maps to Service Bus scheduled messages or Durable Functions
 *   timers so windows survive process restarts.
 */

const crypto = require("node:crypto");

const REMINDER_FRACTIONS = [
  { f: 0.2, label: "second-notice" },
  { f: 0.4, label: "reminder" },
  { f: 0.7, label: "final-warning" },
];

class Orchestrator {
  /**
   * @param {object} opts
   * @param {{windowSec:number, chain:{userId:string,name:string,role:string}[]}} opts.policy
   * @param {(event:object)=>void} [opts.emit]  push-channel callback (SSE/APNs/FCM adapter)
   * @param {()=>number} [opts.now]             injectable clock for tests
   */
  constructor(opts) {
    if (!opts?.policy?.chain?.length) throw new Error("policy.chain is required");
    if (!Number.isInteger(opts.policy.windowSec) || opts.policy.windowSec <= 0)
      throw new Error("policy.windowSec must be a positive integer");
    this.policy = opts.policy;
    this.emit = opts.emit || (() => {});
    this.now = opts.now || Date.now;
    /** @type {Map<string, object>} */
    this.alerts = new Map();
    /** @type {Map<string, {timeout:any, reminders:any[]}>} timers keyed by alertId */
    this.timers = new Map();
    this.onChange = () => {};
  }

  // ---------- commands ----------

  /** Support system raises an alert (idempotent on externalId). */
  createAlert(payload) {
    const required = ["ticketId", "title", "priority", "queueId"];
    for (const k of required) {
      if (!payload?.[k] || typeof payload[k] !== "string")
        return { ok: false, code: 400, error: `Missing or invalid field: ${k}` };
    }
    if (payload.externalId) {
      const dup = [...this.alerts.values()].find((a) => a.externalId === payload.externalId);
      if (dup) return { ok: true, alert: this.view(dup), deduplicated: true };
    }
    const alert = {
      id: crypto.randomUUID(),
      externalId: payload.externalId || null,
      ticketId: payload.ticketId,
      title: payload.title,
      customer: payload.customer || null,
      priority: payload.priority,
      queueId: payload.queueId,
      supportUrl: payload.supportUrl || null,
      status: "ringing",
      stageIndex: -1,
      acceptedBy: null,
      acceptedAt: null,
      attempts: [],
      audit: [],
      createdAt: this.iso(),
    };
    this.alerts.set(alert.id, alert);
    this.audit(alert, "alert.created", `${alert.priority} ${alert.ticketId} on queue ${alert.queueId}`);
    this.startNextAttempt(alert);
    this.onChange();
    return { ok: true, alert: this.view(alert) };
  }

  /** First valid acceptance wins; processed atomically. Any chain member may accept. */
  accept(alertId, userId) {
    const alert = this.alerts.get(alertId);
    if (!alert) return { ok: false, code: 404, error: "Alert not found" };
    const user = this.userInChain(userId);
    if (!user) return { ok: false, code: 403, error: "User is not in the escalation chain" };
    if (alert.status !== "ringing") {
      return {
        ok: false, code: 409, error: "Incident already resolved",
        status: alert.status, acceptedBy: alert.acceptedBy, acceptedAt: alert.acceptedAt,
      };
    }
    // Atomic check-and-set (single-threaded). SQL port: conditional UPDATE.
    alert.status = "accepted";
    alert.acceptedBy = userId;
    alert.acceptedAt = this.iso();
    this.closeOpenAttempt(alert, userId === this.currentTarget(alert)?.userId ? "accepted" : "accepted-by-other");
    this.clearTimers(alertId);
    this.audit(alert, "alert.accepted", `Accepted by ${user.name}`);
    this.audit(alert, "alert.broadcast-cancel", "Alerts cancelled on all devices");
    this.emit({ type: "accepted", alertId, userId, name: user.name, at: alert.acceptedAt });
    this.onChange();
    return { ok: true, alert: this.view(alert) };
  }

  /** Reject never waits for the timer — escalates immediately. Only the current target may reject. */
  reject(alertId, userId, reason) {
    const alert = this.alerts.get(alertId);
    if (!alert) return { ok: false, code: 404, error: "Alert not found" };
    if (alert.status !== "ringing")
      return { ok: false, code: 409, error: "Incident already resolved", status: alert.status };
    const target = this.currentTarget(alert);
    if (!target || target.userId !== userId)
      return { ok: false, code: 403, error: "Only the currently alerted responder can reject" };
    this.clearTimers(alertId);
    this.closeOpenAttempt(alert, reason ? `rejected:${reason}` : "rejected");
    this.audit(alert, "attempt.rejected", `Rejected by ${target.name}${reason ? `: ${reason}` : ""}`);
    this.emit({ type: "attempt-closed", alertId, userId, result: "rejected" });
    this.startNextAttempt(alert);
    this.onChange();
    return { ok: true, alert: this.view(alert) };
  }

  /** Support system withdraws the alert (e.g. ticket resolved another way). */
  cancel(alertId, why) {
    const alert = this.alerts.get(alertId);
    if (!alert) return { ok: false, code: 404, error: "Alert not found" };
    if (alert.status !== "ringing")
      return { ok: false, code: 409, error: "Incident already resolved", status: alert.status };
    this.clearTimers(alertId);
    this.closeOpenAttempt(alert, "cancelled");
    alert.status = "cancelled";
    this.audit(alert, "alert.cancelled", why || "Cancelled by source system");
    this.emit({ type: "cancelled", alertId });
    this.onChange();
    return { ok: true, alert: this.view(alert) };
  }

  // ---------- internals ----------

  startNextAttempt(alert) {
    alert.stageIndex += 1;
    if (alert.stageIndex >= this.policy.chain.length) {
      alert.status = "exhausted";
      this.audit(alert, "alert.exhausted", "No stage accepted — emergency fallback triggered");
      this.emit({ type: "exhausted", alertId: alert.id });
      return;
    }
    const target = this.policy.chain[alert.stageIndex];
    const attempt = {
      id: crypto.randomUUID(),
      stage: alert.stageIndex + 1,
      userId: target.userId,
      name: target.name,
      role: target.role,
      startedAt: this.iso(),
      windowSec: this.policy.windowSec,
      result: "open",
      endedAt: null,
    };
    alert.attempts.push(attempt);
    this.audit(alert, "attempt.started", `Alerted ${target.name} (${target.role}) — stage ${attempt.stage}`);
    this.emit({
      type: "ring", alertId: alert.id, userId: target.userId, stage: attempt.stage,
      windowSec: this.policy.windowSec,
      ticket: { ticketId: alert.ticketId, title: alert.title, customer: alert.customer, priority: alert.priority },
    });
    this.armTimers(alert, attempt);
  }

  armTimers(alert, attempt) {
    const ms = this.policy.windowSec * 1000;
    const reminders = REMINDER_FRACTIONS.map((r) => {
      const h = setTimeout(() => {
        if (alert.status !== "ringing") return;
        this.audit(alert, "attempt.reminder", `${r.label} to ${attempt.name}`);
        this.emit({ type: "reminder", alertId: alert.id, userId: attempt.userId, label: r.label });
      }, Math.round(ms * r.f));
      h.unref?.();
      return h;
    });
    const timeout = setTimeout(() => this.onTimeout(alert.id, attempt.id), ms);
    timeout.unref?.();
    this.timers.set(alert.id, { timeout, reminders });
  }

  onTimeout(alertId, attemptId) {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.status !== "ringing") return;
    const attempt = alert.attempts.find((a) => a.id === attemptId);
    if (!attempt || attempt.result !== "open") return;
    attempt.result = "timed-out";
    attempt.endedAt = this.iso();
    this.clearTimers(alertId);
    this.audit(alert, "attempt.timed-out", `No response from ${attempt.name} — attempt closed`);
    this.emit({ type: "attempt-closed", alertId, userId: attempt.userId, result: "timed-out" });
    this.startNextAttempt(alert);
    this.onChange();
  }

  closeOpenAttempt(alert, result) {
    const open = alert.attempts.find((a) => a.result === "open");
    if (open) {
      open.result = result;
      open.endedAt = this.iso();
    }
  }

  clearTimers(alertId) {
    const t = this.timers.get(alertId);
    if (!t) return;
    clearTimeout(t.timeout);
    t.reminders.forEach(clearTimeout);
    this.timers.delete(alertId);
  }

  currentTarget(alert) {
    return this.policy.chain[alert.stageIndex] || null;
  }

  userInChain(userId) {
    return this.policy.chain.find((u) => u.userId === userId) || null;
  }

  audit(alert, event, detail) {
    alert.audit.push({ at: this.iso(), event, detail });
  }

  iso() {
    return new Date(this.now()).toISOString();
  }

  // ---------- queries ----------

  view(alert) {
    const { ...v } = alert;
    return structuredClone(v);
  }

  getAlert(id) {
    const a = this.alerts.get(id);
    return a ? this.view(a) : null;
  }

  listAlerts({ activeOnly = false } = {}) {
    return [...this.alerts.values()]
      .filter((a) => !activeOnly || a.status === "ringing")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((a) => this.view(a));
  }

  // ---------- persistence (production: Azure SQL; here: JSON snapshot) ----------

  toJSON() {
    return { policy: this.policy, alerts: [...this.alerts.values()] };
  }

  /** Restore from snapshot; re-arms timers on still-ringing alerts with remaining time. */
  restore(snapshot) {
    if (!snapshot?.alerts) return;
    if (snapshot.policy) this.policy = snapshot.policy;
    for (const alert of snapshot.alerts) {
      this.alerts.set(alert.id, alert);
      if (alert.status !== "ringing") continue;
      const open = alert.attempts.find((a) => a.result === "open");
      if (!open) { this.startNextAttempt(alert); continue; }
      const elapsed = this.now() - Date.parse(open.startedAt);
      const remaining = open.windowSec * 1000 - elapsed;
      this.audit(alert, "orchestrator.recovered", "Timers re-armed after restart");
      if (remaining <= 0) {
        this.onTimeout(alert.id, open.id);
      } else {
        const timeout = setTimeout(() => this.onTimeout(alert.id, open.id), remaining);
        timeout.unref?.();
        this.timers.set(alert.id, { timeout, reminders: [] });
      }
    }
  }
}

module.exports = { Orchestrator, REMINDER_FRACTIONS };
