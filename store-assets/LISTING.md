# Chrome Web Store listing — Web SIP Phone

The source of truth for the store listing copy. Every state word below is read off
`src/content/view.ts` (`dotFor()`, `labelFor()`, `FAULT_TITLE`, `FAULT_COPY`) — if the UI copy
changes, change it here in the same commit.

- **Category:** Workflow & Planning
- **Language:** English
- **Version:** 1.0.3
- **Privacy policy URL:** https://github.com/rasonyang/web-sip-phone/blob/main/PRIVACY.md
- **Support URL:** https://github.com/rasonyang/web-sip-phone/issues

## Short description (127 / 132 chars — mirrors `manifest.json`)

```
Keeps a WebRTC SIP extension registered over WSS and shows a headset button with live connection status on the pages you allow.
```

## Detailed description

```
Web SIP Phone keeps a WebRTC SIP connection alive in your browser and shows a small
draggable headset button — with a status badge on its corner — on the business pages
you allow.

STATUS AT A GLANCE
• Green badge — registered and ready
• Amber badge, pulsing — connecting, registering, or reconnecting after a drop
• Red badge — a fault, or nothing running (not configured, or no allowed page open)
• The button itself tinted — a call is in progress; the badge keeps reporting
  connection health, so a call never hides a connection problem

Status is never carried by colour alone: the same wording is in the button's tooltip
and its accessible label, and the panel repeats every signal as a check, warning or
cross shape.

HOW IT WORKS
• Registers a single SIP extension over secure WebSocket (WSS)
• Auto-answers server-initiated calls (Call-Info answer-after)
• Supports remote talk/hold control (BroadSoft Event: talk/hold)
• Click the button for the Voice connection panel: which extension you are on which
  server, signalling health with the registration expiry counting down, your
  microphone with its device name and a live input level, and TURN readiness
• A fault opens the panel on its own, names the server's own reason — "Registration
  failed (403 Forbidden) — check password in Settings" — counts down to the next
  retry, and offers the one action that fixes it. It stays open until the fault
  clears; a fault is dismissed by fixing it, not by hiding it
• Copy diagnostics puts the whole picture on your clipboard for a support ticket.
  Your SIP password is never included — it never leaves Settings

Web SIP Phone is a connection indicator, not a softphone: your business page keeps
full control of dialing, answering and call information. Call state never reaches the
page — no numbers, no timers, no call controls. It only runs on the HTTPS sites you
explicitly allow in Settings, and only while one of those tabs is open.

REQUIREMENTS
• A SIP server reachable over WSS (e.g. FreeSWITCH with wss-binding)
• Microphone access, granted once from Settings → Advanced → Test microphone
• Chrome 116 or newer
```

## Single purpose

Maintain one SIP-over-WSS registration for the user's own extension and show its connection
health on the sites the user allows.

## Permission justifications (review form)

| Permission | Justification |
| --- | --- |
| `storage` | Stores the user's SIP account settings, allowed-sites list, optional TURN settings and the widget's dragged position locally via `chrome.storage.local`. Nothing is sent anywhere. |
| `offscreen` | Manifest V3 service workers cannot hold a WebRTC peer connection, a WebSocket or a media stream. The SIP.js user agent, the SIP-over-WSS link, the microphone and remote audio playback all live in a single offscreen document. |
| `scripting` | Registers the content script dynamically for exactly the hostnames the user added to Allow Sites, so the status widget appears only there — not on every page. |
| `tabs` | Detects whether an allowed-site tab is open. Registration is held only while one is; when the last one closes the extension unregisters. Only tab URLs are inspected, and only to match them against the user's own allow list. |
| `optional_host_permissions` (`https://*/*`) | Requested at the moment the user adds a site in Settings, one hostname at a time via `chrome.permissions.request`, and revoked when the site is removed. Never requested at install time. Loopback (`localhost`, `127.0.0.1`) is included for local testing against a development SIP server. |

## Remote code

None. The extension bundles all of its JavaScript (esbuild → `dist/`), including the SIP.js fork.
Nothing is fetched and executed at runtime.

## Data usage disclosures

- Personally identifiable information: **no**
- Health, financial, authentication, personal communications, location, web history, user
  activity: **no**
- Website content: **no**
- The SIP password is stored locally and sent only to the SIP server the user configured, over
  WSS, as SIP digest authentication — never to the developer.
- Certify: data is not sold, not used for unrelated purposes, not used for creditworthiness.

## Screenshots (1280×800)

| File | Shows |
| --- | --- |
| `1-ready-green.png` | The collapsed headset button docked top-right on a business page, green badge |
| `2-status-panel.png` | The Voice connection panel: extension identity, signaling with expiry countdown, microphone with level meter, TURN |
| `3-on-a-call.png` | A call in progress — the button tinted, the badge still green |
| `4-options.png` | The options page: Account, Allow Sites, Advanced |

`demo.mp4` is the reviewer walkthrough: register → panel → auto-answered call → hangup.
