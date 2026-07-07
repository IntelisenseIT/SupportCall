# SupportCall — PWA build

A progressive web app version of the out-of-hours incident alert prototype.
Installs to a phone home screen, runs standalone, works offline, and persists
your settings and support hours on the device.

## Files

| File | Purpose |
| --- | --- |
| index.html | The app (all screens and logic) |
| manifest.webmanifest | Install metadata — name, icons, standalone display |
| sw.js | Service worker — offline shell caching, push and notification-click handlers |
| icon-192.png, icon-512.png, icon-maskable-512.png | App icons |

## Hosting

PWAs require HTTPS (localhost is exempt for testing). Any static host works:

- Quick test on your machine: `python3 -m http.server 8080` in this folder,
  then open http://localhost:8080
- To reach a phone, host it on HTTPS: an internal IIS/nginx site, Azure Static
  Web Apps, GitHub Pages, or similar. Serve the folder as-is; no build step.

## Installing on a phone

**Android (Chrome/Edge):** open the URL — an "Install SupportCall on this
device" button appears on the Readiness screen (or use the browser menu →
Install app). Notifications require accepting the permission prompt
(Android 13+).

**iPhone/iPad (Safari):** open the URL → Share → Add to Home Screen. On
iOS 16.4+ web notifications only work after the app has been added to the
home screen and permission is granted from inside the app (Readiness screen).

## What this build does and doesn't do

Does: installable app, offline shell, on-device settings and support hours,
real notifications and alert audio while the app is open, the full
accept/reject/escalate/audit demo loop.

Doesn't (by design of the web platform): receive pushes with no backend —
the sw.js push handler is ready, but real delivery while the app is closed
requires a Web Push backend (VAPID keys + a server). And there is no web
equivalent of Apple Critical Alerts or Android full-screen intents — a PWA
cannot override mute or Do Not Disturb.

This matches the design document's position (section 3): the PWA is a
secondary/demo channel; production alerting should be native push via
APNs/FCM, with the alert orchestrator server-side.

## Support hours

Settings → Support hours configures your on-call window per weekday.
An end time earlier than the start spans midnight (18:00–07:00). Equal
start and end means on call all day. The Status screen shows live
on-call/off-call state and your next shift; Readiness reflects it too.

## Sign-in and security

Each support worker signs in with their work email and name. Settings,
support hours, escalation chain, and security choices are stored per user
on the device, so multiple workers can share a test device without
overwriting each other.

The sign-in itself is simulated in this demo build. Production must
authenticate against Microsoft Entra ID (OIDC via MSAL.js for a PWA, or
MSAL.NET in the MAUI client), issue tokens, and bind the device
registration to the immutable User ID for alert routing (design document
section 5). Do not treat the demo sign-in as access control.

What IS real in this build is the app lock, which addresses "don't let
others use their app":

- Biometric lock — a WebAuthn platform authenticator (Face ID, Android
  fingerprint, Windows Hello). The OS enforces user verification; the
  credential is bound to this device. Requires HTTPS (or localhost).
- PIN lock fallback — 4–8 digits, stored as a salted SHA-256 hash on the
  device, never in plain text.
- Auto-lock after 1/5/15 minutes of inactivity or time away, plus a
  manual "Lock now".
- Accepting an incident while locked forces identity verification first,
  and the audit trail records "Identity verified on this device". An
  incident ringing while locked shows a banner on the lock screen but
  cannot be accepted without unlocking.
- Readiness warns when the app lock is off.
