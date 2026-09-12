# Web SIP Phone

A Chrome extension that maintains a WebRTC SIP voice link and shows a small draggable **headset
button** on configured business pages, with a status badge on its top-right corner. The badge
reports connection health only:

| Badge | Meaning | Tooltip |
| --- | --- | --- |
| **green** | registered and ready | `Voice ready` |
| **amber, pulsing** | connecting, registering, or reconnecting after a drop | `Connecting…` / `Reconnecting…` |
| **red** | a fault, or no runtime (not configured, no Allow Site tab) | `Registration failed`, `Voice connection lost`, `Microphone unavailable`, `Call audio failed`, `Not connected` |

Call activity never moves the badge: it tints the button itself indigo and says so in the tooltip
(`On a call`). State is never carried by colour alone — the same wording is on the button's tooltip
and `aria-label`, and the panel repeats every signal as a check / warning / cross shape.

Clicking the widget opens the `Voice connection` panel (see below); a fault opens it on its own and
holds it open until the fault clears.

The widget follows the shadcn/ui neutral look (Inter, lucide-style icons) so it blends into
shadcn-based host applications. It is **not** a softphone: all call control (dial, answer, hangup,
hold, resume) is driven by the SIP server (e.g. FreeSWITCH) using BroadSoft access-side extensions;
the page's own softphone bar owns all call-facing UI. SIP support comes from a
[SIP.js fork](https://github.com/rasonyang/SIP.js) with enhanced BroadSoft extensions
(Call-Info answer-after auto-answer, remote `Event: talk`/`Event: hold` control).

## Build and install
- `npm install` (builds the pinned SIP.js fork from git — first run is slow)
- `npm run gen-icons && npm run build` → `dist/`
- `npm test` — unit + integration tests (Vitest)
- `npm run package` — store-submittable zip
- `npm run demo` — serves `store-assets/demo-page/` on http://localhost:8100, the stand-in business
  page used for the store screenshots (add `localhost` under Allow Sites)
- `npm run shoot` — re-takes store screenshots 1–3 from source (headless Chrome, 1280×800)

## Load unpacked
1. chrome://extensions → enable Developer mode → Load unpacked → select `dist/`.
2. The options page opens on first install.

## FreeSWITCH prerequisites
See docs/FREESWITCH.md: a WebSocket binding in the verto/sofia profile — `wss-binding` plus TLS
certs, or `ws-binding` on a trusted network — `Call-Info <...>;answer-after=0` on agent-first
originations, and `uuid_phone_event <uuid> talk|hold` for remote answer/hold/resume.

## Configuration
- **Account**: Domain (hostname only, e.g. `voice.example.com`), Account (e.g. `1001`), Password,
  and an optional Server URL. The SIP URI is always derived as `sip:1001@voice.example.com`; the
  WebSocket endpoint is derived as `wss://voice.example.com/` (port 443, path `/`, subprotocol
  `sip`) while Server URL is empty. Filling Server URL replaces that derivation entirely and takes
  any `ws://` or `wss://` URL — `wss://voice.example.com:7443/`, `ws://192.168.1.10:5066/` — so the
  WebSocket host need not be the SIP domain. Plain `ws://` leaves SIP signaling unencrypted (media
  is still DTLS-SRTP, but its fingerprints travel in cleartext SDP): trusted networks only, see
  docs/FREESWITCH.md §1.
- **Allow Sites**: exact hostnames, HTTPS only, one per entry. Adding a site triggers a Chrome
  per-site permission prompt; removing revokes it. Registration only happens while at least one
  Allow Site tab is open.
- **Microphone**: use *Advanced → Test microphone* once to grant access. Without it Web SIP Phone will
  not register and shows "Microphone unavailable".
- **STUN/TURN**: Google STUN by default; optional TURN under Advanced (takes effect on the next call).

## The Voice connection panel
Clicking the widget opens a panel that answers *who am I on this system, and what is likely to
break a call*:

```
Voice connection                        ✓ Voice ready
──────────────────────────────────────────────────────
Extension    1001 @ voice.example.com
Signaling  ✓ WSS · expires in 4:12                    ›
Microphone ✓ MacBook Pro Microphone              ▁▃▅▇
TURN       ⚠ Not configured
──────────────────────────────────────────────────────
Reconnect  Test microphone  Copy diagnostics  Settings  v1.0.4
```

- **Signaling** merges SIP registration and WebSocket — in SIP over WebSocket they cannot disagree —
  and counts down the registration expiry the server granted. The `›` chevron reveals the four
  raw signals (SIP registration, WebSocket, Microphone, Media) plus TURN's full consequence.
- **Microphone** names the device and shows a live input level, measured in the offscreen
  document and streamed only while a panel is open. The content script never touches the mic.
- A fault replaces the row it belongs to, banded red, naming the server's reason and what to do —
  `Registration failed (403 Forbidden) — check password in Settings` — with a retry countdown
  while the runtime backs off.
- The footer carries exactly one emphasised action. While a fault is up, that action replaces
  `Reconnect` and is the recovery step for that fault (`Retry now`, `Enable microphone`,
  `Configure TURN`), with `Settings` next to it; `Test microphone`, `Copy diagnostics` and the
  extension version are always there.
- **Copy diagnostics** puts the version, account, every signal state, the last error and the
  relevant timestamps on the clipboard. Credentials are never included.

## Testing the ringtone
Place a normal call to the account from another extension (no `Call-Info: …;answer-after=…`): the
ringtone starts as the INVITE arrives and stops on `uuid_phone_event <uuid> talk`, on CANCEL, or on
any other exit from RINGING. An Agent First call must stay silent. Chrome's autoplay policy does
not apply to the extension's own offscreen document, but a refused `play()` is caught, logged to the
diagnostic log, and never fails the call.

## Testing Talk/Hold against FreeSWITCH
`uuid_phone_event <uuid> talk` while ringing answers the browser leg; `hold` puts an active call on
hold (re-INVITE sendonly); `talk` again resumes. See docs/FREESWITCH.md for a full walkthrough.

## Troubleshooting
| Symptom | Check |
| --- | --- |
| Registration failed | The panel names the SIP reason (`403 Forbidden` → password, `404` → unknown extension); FreeSWITCH's WebSocket binding reachable at the configured Server URL, or at `wss://<domain>/` when that field is empty |
| Voice server unreachable | Network and WebSocket endpoint (scheme, port and path of Server URL must match the sofia `ws-binding`/`wss-binding`); `Retry now` in the panel; backoff continues automatically |
| Microphone blocked | Options → Advanced → Test microphone (the panel's own test hands you there — only the Options page can raise Chrome's prompt), or chrome://settings/content/microphone |
| Call audio failed | Configure TURN (Advanced); typical on symmetric NAT |
| No dot on the page | Site listed exactly (no subdomain difference), HTTPS, permission granted |

## Architecture

Web SIP Phone runs four cooperating pieces, all in `src/`:

- **Service worker** (`src/background`, MV3 background) — extension lifecycle, Allow Site tab
  tracking, options/config storage, message routing between content scripts and the offscreen
  document, and creating/destroying the offscreen document. It never runs SIP.js or holds a live
  WebRTC session; it only aggregates state broadcast by the offscreen document and relays it to
  every open Allow Site tab.
- **Offscreen document** (`src/offscreen`) — the single global SIP.js `UserAgent`, the SIP over
  WebSocket connection, REGISTER/unregister, the one allowed SIP session, microphone acquisition,
  remote audio playback, the inbound ringtone, and the call state machine (`READY → DIALING/RINGING → ACTIVE ⇄ HELD → ENDED`)
  driven by INVITE, CANCEL, BYE, and BroadSoft `NOTIFY`/`Event: talk`/`Event: hold`. State changes
  are broadcast to the service worker; nothing here is rendered directly.
- **Content script** (`src/content`) — injected only into top-level Allow Site pages (never
  iframes). Renders the Web SIP Phone dot and the `Voice connection` panel in a Shadow DOM,
  handles dragging and expand/collapse. It is a pure view of the offscreen runtime and owns no
  part of the call: reloading or leaving the page destroys the content script, never the SIP
  session (see *Page reload never ends a call* below). It never holds the SIP password, never runs SIP.js,
  never opens a WebSocket, and never touches the microphone directly — the level meter and the
  microphone test both run in the offscreen document.
- **Options page** (`src/options`) — Account, Allow Sites, Advanced (microphone test, TURN), and
  About.

**Call states never render UI.** DIALING, RINGING, ACTIVE, HELD, and ENDED are internal-only: the
content script is sent a single `busy` boolean, which tints the collapsed button, and nothing
else — no numbers, no duration, no call controls. The panel only
auto-expands for the four connection-level errors: registration failure, WebSocket loss, microphone
failure, and media failure.

**Page reload never ends a call.** The SIP session, the `RTCPeerConnection`, the microphone and
the remote audio all live in the offscreen document; a content script is only a view of them. The
service worker keeps the runtime alive while `allowedTabCount > 0 OR activeCall`, and destroys it
(unregister, close the WebSocket, stop media, close the document) only when there is no Allow Site
tab *and* no call in progress. So refreshing an Allow Site page during a call does not interrupt audio,
change the SIP Call-ID, or produce a new INVITE — the reloaded page just asks for the current
state and shows the call already in progress. There is no `beforeunload` prompt and no session
resume: nothing is serialized or restored, the runtime simply outlives the page. See design.md
§6.5.

**One call state does make a sound.** A normal inbound call (no `Answer-After`) enters RINGING, and
the offscreen document loops the bundled ringtone `static/sounds/ringtone.wav` on its own
`<audio>` element until the state leaves RINGING — answered, cancelled, failed, or discarded with
the transport. Answering stops it the moment the answer is issued, not when media comes up. Agent
First calls (`answer-after=…`) go to DIALING and stay silent. There is no ringtone picker and no
volume control in version 1; the sound is changed by editing the constants at the top of
`scripts/gen-ringtone.mjs` and running `npm run gen-ringtone` (the script is deterministic — a
plain regeneration reproduces the same bytes).

## Test coverage

`npm test` runs 20 files / 247 tests: unit tests (header parsing, the call state machine, the
ringtone player, Allow Site matching, multiple-call rejection, error priority) plus integration
tests against a mock SIP transport that exercise design.md §22.2 items 1–12 end to end (REGISTER
success/failure, WSS disconnect/reconnect, Answer-After auto-answer, normal INVITE → RINGING with
the ringtone starting, Talk while RINGING/DIALING/HELD, Hold while ACTIVE, CANCEL while RINGING,
BYE while ACTIVE/HELD). The
remaining §22.2 items are covered elsewhere rather than in the integration suite:

- Item 13 (ICE failure) — unit-covered in `test/offscreen/call-session.test.ts`.
- Item 14 (subsequent calls succeed after TURN is configured) — unit-covered in
  `test/shared/config.test.ts` (TURN server-list assembly).
- Item 15 (multi-tab state synchronization) — unit-covered in
  `test/background/service-worker.test.ts`, including the status-panel payload (identity,
  registration expiry, backoff progress, microphone device/level, fault reason).

The design.md §22.3 FreeSWITCH live-acceptance items (real SIP over WebSocket, two-way audio, etc.)
require a live FreeSWITCH environment and are tracked as a fillable checklist in
docs/FREESWITCH.md, not run by the automated suite.

## Further reading
- docs/FREESWITCH.md — FreeSWITCH integration notes and live acceptance checklist.
- docs/KNOWN-LIMITATIONS.md — accepted limitations for version 1.