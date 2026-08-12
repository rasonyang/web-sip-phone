# Web SIP Phone

A Chrome extension that maintains a WebRTC SIP voice link and shows a small draggable **desk-phone
icon** with a status dot (top-right corner) on configured business pages:

- 🟢 **green** — registered and ready
- 🟡 **amber** — a call is in progress
- 🔴 **red** — not connected (blinking while connecting/reconnecting)

The widget follows the shadcn/ui neutral look (Inter, lucide-style icon) so it blends into
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

## Load unpacked
1. chrome://extensions → enable Developer mode → Load unpacked → select `dist/`.
2. The options page opens on first install.

## FreeSWITCH prerequisites
See docs/FREESWITCH.md: wss binding in the verto/sofia profile (`wss-binding`), TLS certs,
`Call-Info <...>;answer-after=0` on agent-first originations, and `uuid_phone_event <uuid> talk|hold`
for remote answer/hold/resume.

## Configuration
- **Account**: Domain (hostname only, e.g. `voice.example.com`), Account (e.g. `1001`), Password.
  Derived automatically: SIP URI `sip:1001@voice.example.com`, WSS `wss://voice.example.com/`
  (port 443, path `/`, WebSocket subprotocol `sip`).
- **Allow Sites**: exact hostnames, HTTPS only, one per entry. Adding a site triggers a Chrome
  per-site permission prompt; removing revokes it. Registration only happens while at least one
  Allow Site tab is open.
- **Microphone**: use *Advanced → Test microphone* once to grant access. Without it Web SIP Phone will
  not register and shows "Microphone unavailable".
- **STUN/TURN**: Google STUN by default; optional TURN under Advanced (takes effect on the next call).

## Testing Talk/Hold against FreeSWITCH
`uuid_phone_event <uuid> talk` while ringing answers the browser leg; `hold` puts an active call on
hold (re-INVITE sendonly); `talk` again resumes. See docs/FREESWITCH.md for a full walkthrough.

## Troubleshooting
| Symptom | Check |
| --- | --- |
| Registration failed | Domain/account/password; FreeSWITCH WSS reachable at `wss://<domain>/` |
| Voice connection lost | Network/WSS; use Retry on the dot; backoff continues automatically |
| Microphone unavailable | Advanced → Test microphone; chrome://settings/content/microphone |
| Media connection failed | Configure TURN (Advanced); typical on symmetric NAT |
| No dot on the page | Site listed exactly (no subdomain difference), HTTPS, permission granted |

## Architecture

Web SIP Phone runs four cooperating pieces, all in `src/`:

- **Service worker** (`src/background`, MV3 background) — extension lifecycle, Allow Site tab
  tracking, options/config storage, message routing between content scripts and the offscreen
  document, and creating/destroying the offscreen document. It never runs SIP.js or holds a live
  WebRTC session; it only aggregates state broadcast by the offscreen document and relays it to
  every open Allow Site tab.
- **Offscreen document** (`src/offscreen`) — the single global SIP.js `UserAgent`, the SIP over
  WSS connection, REGISTER/unregister, the one allowed SIP session, microphone acquisition, remote
  audio playback, and the call state machine (`READY → DIALING/RINGING → ACTIVE ⇄ HELD → ENDED`)
  driven by INVITE, CANCEL, BYE, and BroadSoft `NOTIFY`/`Event: talk`/`Event: hold`. State changes
  are broadcast to the service worker; nothing here is rendered directly.
- **Content script** (`src/content`) — injected only into top-level Allow Site pages (never
  iframes). Renders the Web SIP Phone dot in a Shadow DOM, handles drag/edge-snap and expand/collapse,
  and registers a best-effort `beforeunload` leave confirmation when a call is in progress. It
  never holds the SIP password, never runs SIP.js, never opens a WebSocket, and never touches the
  microphone directly.
- **Options page** (`src/options`) — Account, Allow Sites, Advanced (microphone test, TURN), and
  About.

**Call states never render UI.** DIALING, RINGING, ACTIVE, HELD, and ENDED are internal-only —
Web SIP Phone always shows the same collapsed status dot during a call, with no numbers, duration, or
call controls. The dot only auto-expands for the four connection-level errors: registration
failure, WSS loss, microphone failure, and media failure.

## Test coverage

`npm test` runs 17 files / 129 tests: unit tests (header parsing, the call state machine, Allow
Site matching, multiple-call rejection, error priority) plus integration tests against a mock SIP
transport that exercise design.md §22.2 items 1–12 end to end (REGISTER success/failure, WSS
disconnect/reconnect, Answer-After auto-answer, normal INVITE → RINGING, Talk while
RINGING/DIALING/HELD, Hold while ACTIVE, CANCEL while RINGING, BYE while ACTIVE/HELD). The
remaining §22.2 items are covered elsewhere rather than in the integration suite:

- Item 13 (ICE failure) — unit-covered in `test/offscreen/call-session.test.ts`.
- Item 14 (subsequent calls succeed after TURN is configured) — unit-covered in
  `test/shared/config.test.ts` (TURN server-list assembly).
- Item 15 (multi-tab state synchronization) — unit-covered in
  `test/background/service-worker.test.ts`.

The design.md §22.3 FreeSWITCH live-acceptance items (real SIP over WSS, two-way audio, etc.)
require a live FreeSWITCH environment and are tracked as a fillable checklist in
docs/FREESWITCH.md, not run by the automated suite.

## Further reading
- docs/FREESWITCH.md — FreeSWITCH integration notes and live acceptance checklist.
- docs/KNOWN-LIMITATIONS.md — accepted limitations for version 1.