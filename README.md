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

Clicking the widget opens the `Voice connection` panel (see below); a fault opens it on its own,
once. Clicking the widget again, clicking elsewhere on the page, or pressing Escape puts it away —
the red badge goes on reporting the fault, and the same fault does not force the panel back open.

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
- **Account**: Server (e.g. `voice.example.com`), Account (e.g. `1001`), and Password. Server takes
  a bare hostname, which defaults to `wss://voice.example.com/` (port 443, path `/`, subprotocol
  `sip`), or a fuller address with a scheme, port and path — `wss://voice.example.com:7443/`,
  `ws://192.168.1.10:5066/`. The SIP domain is the hostname of whatever is entered, so the SIP URI
  here is `sip:1001@voice.example.com`. Plain `ws://` leaves SIP signaling unencrypted (media is
  still DTLS-SRTP, but its fingerprints travel in cleartext SDP) and is accepted only for
  private-network and local addresses; see docs/FREESWITCH.md §1. Filling this in is optional when
  an Allow Site page supplies the credential itself — see [Host-page provisioning](#host-page-provisioning).
- **Allow Sites**: exact hostnames, one per entry — no wildcards, no subdomain inheritance, and no
  scheme, port or path in the box. Ports never take part in matching, so one entry covers every port
  on that host. HTTPS only, except private-network addresses (`localhost` and any `.localhost` name,
  `127.x`, `10.x`, `172.16.x`–`172.31.x`, `192.168.x`), which are also allowed over HTTP. Adding a
  site triggers a Chrome per-site permission prompt; removing revokes it. Registration only happens
  while at least one Allow Site tab is open.
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
Reconnect  Test microphone  Copy diagnostics  Settings  v1.0.7
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

## Host-page provisioning

An Allow Site page can hand Web SIP Phone a SIP credential instead of the user typing one into
Options. The page pushes a pre-hashed credential in; the extension answers with registration state
only.

**Presence marker.** On injection into an Allow Site page the content script sets
`document.documentElement.dataset.webSipPhone` to the extension version (e.g. `"1.0.7"`),
synchronously, before the page's own scripts run. It is set only on Allow Site pages and only in
the top frame, so it is the page's first-pass test for "the extension is installed *and* this site
is allowed". Removing the site from Allow Sites (or revoking its host permission) removes the marker
and the widget from every open tab on that site immediately, and stops the bridge answering. Every
`hello` is also checked with the service worker, even when the content script already has state to
answer with, and one from a site that is no longer allowed is declined: the reply may already be
out, but the marker, the widget and the bridge go with the decline and later messages get no answer.
Treat the marker as the signal to say `hello`, and the `hello` reply — followed by a `state`
message — as the confirmation.

**Already-open tabs.** The page never needs to be refreshed for the extension to reach it. When the
extension is installed or updated, and when a site is added to Allow Sites, the content script is
injected straight into every open tab on an Allow Site whose host permission is granted. The new
instance sets the marker and posts a `state` message unsolicited as soon as it has state, so a page
already listening for `state` sees it without sending `hello` again (a fresh `hello` is answered as
usual). An update or reload leaves the previous content script orphaned: it tears itself down —
removing its widget and the marker, and no longer answering `hello` — when the new instance
replaces it, or as soon as it notices its extension context is gone. If the extension is disabled or
removed with no replacement, the marker goes the next time the orphan is asked anything (a `hello`,
the tab regaining focus), so a page that sees the marker but gets no `hello` reply should treat the
extension as absent. One exception on the first update to 1.0.6 only: a 1.0.5 content script predates
this teardown, so its widget is removed but it can still answer a `hello` from an open tab with its
old `extensionVersion`; ignore a `hello` reply whose `extensionVersion` is older than one already seen.

**Transport.** `window.postMessage` on the page's own window — no `externally_connectable`, no
custom events. The content script accepts a message only when `event.source === window` and
`event.origin === location.origin`, and the service worker independently re-checks the sending
tab's URL against Allow Sites before acting on it. Every message in both directions carries
`source` and `protocolVersion: 1`.

**Page → extension** (`source: "aicc"`):

| `type` | Fields |
| --- | --- |
| `hello` | `nonce` |
| `provision` | `nonce`, `sipDomain`, `wssUrl`, `account`, `a1Hash`, `expiresAt` (RFC 3339 date-time string; epoch ms also accepted) — flat on the message, not nested |
| `deprovision` | — |

**Extension → page** (`source: "web-sip-phone"`):

| `type` | Fields |
| --- | --- |
| `hello` | `nonce` (echoed), `extensionVersion`, `extensionId`, `protocolVersion` |
| `state` | `registration`, `account`, `sipDomain`, `credentialSource`, `provisionStatus`, `microphone`, `error` |

`registration` is `UNREGISTERED | REGISTERING | REGISTERED | FAILED`; `credentialSource` is
`NONE | MANUAL | PROVISIONED`; `provisionStatus` is `NONE | ACTIVE | OVERRIDDEN` (what the extension
*holds*: `OVERRIDDEN` means a provisioned credential is held but the user's manual account is applied,
and a page must not re-provision on it); `microphone` is `UNKNOWN | GRANTED | DENIED`; `error` is
`null | REGISTRATION_FAILED | WSS_LOST | MIC_UNAVAILABLE | MEDIA_FAILED`. A `state` message is sent
on every change and once immediately after the `hello` reply. The content script also posts the
current state unsolicited as soon as it has one (typically before the page sends `hello`), so a
page may treat any `state` it sees as authoritative. It never contains `a1Hash`.

**Precedence.** A provisioned credential wins by default: it replaces a manual registration for as
long as it is held, and a manual account that merely predates the provision never blocks it. It is
cleared on `deprovision`, when `expiresAt` passes, or when the last Allow Site tab closes — and the
extension then falls back to the manual account if one is configured, or unregisters if not.

The one exception is a deliberate override. Saving a manual account in Options *while a credential
is provisioned* sets an override: the manual account is applied and the provisioned credential is
kept, validated and shown read-only, but not used. Options reports it as *Overridden* and offers
**Clear override**, which hands the registration straight back to the held credential — a fresh
`provision` from the page is not needed. Signing out clears the account, the override and the held
credential together.

While an override is active the page-facing `state` reports `credentialSource: "MANUAL"`, exactly
as it would if the user had simply typed an account in. A host page must not treat that as a
failed provision and re-provision in a loop: the credential *was* accepted, the user chose the
other one. Provision on login and on identity transitions, not on every `state`.

**Re-sync.** Options offers a *Re-sync* button, for the case where the extension is waiting on a
credential the page never sent. It clears any provisioning fault and broadcasts fresh state to
every Allow Site tab, which each page receives as an ordinary `state` message — there is no
re-sync message in the protocol, and a page is free to respond by provisioning again or to ignore
it. If nothing arrives within 10 seconds of a `hello` (or of a re-sync), Options reports *No
credential received*; a `provision` that fails validation is reported as *Invalid credential*
immediately. Both are diagnostics for the user, cleared by the next accepted `provision`.

**Credential handling.** The page sends `a1Hash = md5(account:sipDomain:password)` — the SIP realm
is `sipDomain` — never a plaintext password. The hash lives only in `chrome.storage.session`, never
in `chrome.storage.local`, so it does not survive a browser restart. The content script forwards it
and retains nothing. The SIP.js `UserAgent` is built with `authorizationHa1`, and `wssUrl` is used
verbatim — the extension derives no transport address from `sipDomain`.

**Microphone.** On provision the extension performs a real `getUserMedia` before registering. If it
fails, the page sees `microphone: "DENIED"` and `error: "MIC_UNAVAILABLE"`, and no REGISTER is sent.
Registration retries automatically once access is granted.

**Deep links.** `chrome-extension://<extensionId>/options.html?site=<hostname>` opens Options on
Allow Sites with a one-click *Allow &lt;hostname&gt;* button, and closes itself once granted if a page
opened it. `chrome-extension://<extensionId>/options.html#microphone` opens Advanced at the
microphone test. `extensionId` comes from the `hello` reply — do not hard-code it. The manifest
carries the Web Store public `key`, so an unpacked build from `dist/` gets the same id as the store
listing (`dkhaojcfjdcdpldokeokajkmambkbacp`); Chrome will not run both at once, so disable the store
copy while loading unpacked.

```js
if (!document.documentElement.dataset.webSipPhone) return; // not installed, or site not allowed
const nonce = crypto.randomUUID();
const send = (m) => window.postMessage({ source: "aicc", protocolVersion: 1, nonce, ...m }, location.origin);
let sawHello = false;
let sawState = false;
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data;
  if (!m || m.source !== "web-sip-phone" || m.protocolVersion !== 1) return;
  if (m.type === "hello" && m.nonce === nonce) {
    sawHello = true;
    send({ type: "provision", sipDomain: "voice.example.com", wssUrl: "wss://voice.example.com:7443/",
           account: "2001", a1Hash: "<md5(2001:voice.example.com:secret)>", expiresAt: "2026-09-12T20:07:27Z" });
  }
  if (m.type === "state") {
    sawState = true;
    console.log(m.registration, m.credentialSource, m.microphone, m.error);
  }
});
send({ type: "hello" });
setTimeout(() => {
  if (!sawHello) return;            // no reply at all: not installed, or not allowed here
  if (!sawState) notAvailable();    // answered but no state: the extension is not usable yet
}, 2000);
```

The `hello` reply is answered with a `state` message as soon as the extension has state to give.
If a reply arrives but no `state` follows within a couple of seconds, the service worker was
unreachable at that moment — treat the phone as not available and retry with a fresh `hello`
rather than assuming a registration.

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
| Registration failed | The panel names the SIP reason (`403 Forbidden` → password, `404` → unknown extension); FreeSWITCH's WebSocket binding reachable at the address in the Server field |
| Voice server unreachable | Network and WebSocket endpoint (the Server field's scheme, port and path must match the sofia `ws-binding`/`wss-binding`); `Retry now` in the panel; backoff continues automatically |
| Microphone blocked | Options → Advanced → Test microphone (the panel's own test hands you there — only the Options page can raise Chrome's prompt), or chrome://settings/content/microphone |
| Call audio failed | Configure TURN (Advanced); typical on symmetric NAT |
| No dot on the page | Site listed exactly (no subdomain difference); HTTPS, or HTTP on a private-network address (`localhost`/`.localhost`, `127.x`, `10.x`, `172.16.x`–`172.31.x`, `192.168.x`); permission granted |

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

`npm test` runs 27 files / 485 tests: unit tests (header parsing, the call state machine, the
ringtone player, Allow Site matching, multiple-call rejection, error priority, the page-facing
provisioning bridge, content-script teardown and replacement after an extension reload, and the microphone permission watcher and gate) plus integration
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