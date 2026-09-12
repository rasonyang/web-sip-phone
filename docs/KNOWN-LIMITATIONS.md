# Known Limitations (Version 1)

These are accepted trade-offs for version 1, not defects. Version 1 is deliberately scoped to a
status indicator, not a softphone — see design.md §21 for the full out-of-scope list (dial pad,
local answer/hold/hangup, DTMF, transfer, multiple accounts, concurrent calls, video, and more).

- **A call can be in progress with no Web SIP Phone UI anywhere.** The runtime lives in the
  offscreen document and is kept alive while `allowedTabCount > 0 OR activeCall` (design.md §6.5),
  so a call survives losing the last Allow Site tab — a refresh, a closed tab, or an in-tab
  navigation off the Allow Site. During that window there is no dot and no panel to look at: the
  call is still correctly controlled by FreeSWITCH, but the browser shows nothing. Registration is
  dropped and the offscreen document closed as soon as the call ends. This is the deliberate
  trade against the alternative — tearing the runtime down on tab loss, which sends a BYE and
  hangs up on the caller. There is no `beforeunload` leave confirmation; the page is not asked to
  protect a call it does not hold.
- **The offscreen document cannot itself prompt for microphone permission.** `getUserMedia`
  prompts do not surface reliably from an offscreen document; microphone access must be granted
  from the Options page (Advanced → Test microphone) before registration can succeed.
- **Auto-answer never precedes a microphone grant.** Web SIP Phone will never fake a successful answer
  when the user has not granted microphone permission — an Agent First call with no microphone
  access fails rather than silently auto-answering without audio.
- **Single account, single call.** Only one SIP account and one concurrent SIP session are
  supported. An unexpected second INVITE while a call is genuinely in progress (DIALING, RINGING,
  ACTIVE, HELD) is rejected with `486 Busy Here`; the existing session is unaffected. If the slot
  is occupied only by an already-terminal session the reply is `480 Temporarily Unavailable`
  instead — the agent is not on a call, and 486 would both misreport them as busy and land on a
  switch's busy timer rather than its rejection timer. Either rejection is bounded: a slot still
  occupied 15 s after the call left a progress state is discarded, because a switch offers no
  guard of its own here — against FreeSWITCH `mod_callcenter`, a 486 maps to `USER_BUSY`, does
  not count toward `max_no_answer`, and leaves the agent in rotation (verified 2026-08-24). A call that has just ended is *not* busy: the
  FAILED/ENDED reset window is drained on the spot when an INVITE arrives (`handleInvite` in
  `src/offscreen/call-session.ts`) rather than waiting for its timer, so a queue dispatch that
  lands a few hundred milliseconds after the previous call ended is answered, not rejected.
  This matters twice over in an offscreen document: Chrome throttles background timers to the
  one-minute grid and may drop them entirely, and a switch such as FreeSWITCH `mod_callcenter`
  can hold an agent out of rotation for a full `reject_delay_time` after a single 486.
- **Changing the account or TURN settings during a call is deferred until the call ends.** Saving
  new settings restarts the SIP runtime so the new credentials take effect immediately, except
  while a call is in progress — a settings edit must not drop a live call, so the restart waits
  for the call to end.
- **ICE gathering is capped at 1 second** (`iceGatheringTimeout` in `src/offscreen/sipjs-adapter.ts`;
  SIP.js defaults to 5000ms). This keeps answer latency near a second instead of five, which suits
  the LAN-first deployments this targets. Because SIP signaling here is non-trickle, any candidate
  gathered after the cap never reaches the peer: deployments that depend on TURN relay candidates
  across heavy NAT may need the value raised.
- **MV3 service-worker listener-registration timing should be watched during live testing.**
  Chrome requires event listeners (`chrome.runtime.onMessage`, `chrome.tabs.on*`, etc.) to be
  registered synchronously on service-worker startup to reliably survive the worker being woken
  by an event; this codebase registers its listeners after the first `await` in the service
  worker's init sequence. This has not caused a failure in testing, but it is a known deviation
  from the strict MV3 recommendation and is worth specifically watching for missed events (e.g. a
  tab-close or message arriving right as the worker wakes) during manual/live acceptance testing.
- **`options.html` is web-accessible to every `http(s)` origin.** `web_accessible_resources` matches
  `https://*/*` and `http://*/*` (the latter so private-network HTTP Allow Sites can use the deep
  links). Any page that knows the extension id can therefore navigate to `options.html`; the page
  refuses to run inside a frame, and the only privileged action it offers is Chrome's own
  per-site permission prompt, which the user still has to accept.
- **Provisioned credentials do not survive a browser restart.** The `a1Hash` a host page provisions
  lives only in `chrome.storage.session`, deliberately — it is never written to
  `chrome.storage.local`. After a restart the extension comes up with the manual account (or
  unregistered), and the page must provision again after its `hello`.
- **Removing a site from Allow Sites revokes any credential provisioned from it.** A provisioned
  credential is accepted only because its origin is an Allow Site, so taking that site off the list
  drops the credential at once; the extension falls back to the manual account, or goes
  unregistered if there is none. A call already in progress is not cut off — teardown still waits
  for the call to end, per the runtime lifetime rule — but the page must provision again (after the
  site is added back) to register with that credential a second time.
- **A provisioned credential's `expiresAt` may be observed late.** Expiry is enforced by a service
  worker timer plus a check on every state evaluation, but MV3 does not guarantee timers: the
  service worker can be terminated before the timer fires, and the timer dies with it. Expiry is
  therefore guaranteed only at the next state evaluation — a status report, a tab change, or an
  incoming message — so the credential is dropped at the first evaluation at or after `expiresAt`,
  which can lag the stated moment by up to one evaluation.
- **A manual override is visible to the host page only through `state.provisionStatus`.** While
  the user has overridden provisioning by saving a manual account in Options, `credentialSource`
  reports `"MANUAL"` exactly as it does for a plain typed-in account; the two are told apart only by
  `provisionStatus: "OVERRIDDEN"`, a field added after the first v1 build. A page written against the
  original field set cannot see the override and, if it re-provisions on `MANUAL`, changes nothing
  (the credential is validated, accepted and held; Options can hand the registration back with
  *Clear override*) but does re-mint a server-side session each time.
- **`state.registration` cannot distinguish a WSS drop from being unregistered.** The page-facing
  registration value is derived from the extension's own link status, which merges SIP registration
  and WebSocket (they cannot disagree in SIP over WebSocket). A transport reconnect therefore shows
  `UNREGISTERED`/`REGISTERING` with `error: "WSS_LOST"` rather than a state of its own.
- **The ringtone is one fixed bundled sound at the system volume.** `static/sounds/ringtone.wav` is
  the only ringtone; there is no picker and no volume control (design.md §9.4, §17). The sound can be
  changed only by editing the constants in `scripts/gen-ringtone.mjs`, regenerating the asset with
  `npm run gen-ringtone`, and rebuilding. Playback is also
  best-effort: an extension offscreen document is not subject to Chrome's autoplay gesture
  requirement, but if `play()` is ever refused the rejection is swallowed into the diagnostic log —
  the call still arrives and is still answerable, just silently.
