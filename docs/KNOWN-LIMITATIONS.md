# Known Limitations (Version 1)

These are accepted trade-offs for version 1, not defects. Version 1 is deliberately scoped to a
status indicator, not a softphone — see design.md §21 for the full out-of-scope list (dial pad,
local answer/hold/hangup, DTMF, transfer, multiple accounts, concurrent calls, video, and more).

- **`beforeunload` leave confirmation is best-effort only.** Chrome does not guarantee it is
  shown: it may be suppressed if the user has not interacted with the page, and it is never shown
  on a browser crash or a forced system shutdown. If it doesn't show, the tab closes, the call
  ends, and SIP is unregistered without a confirmation step.
- **A page refresh causes unregister/re-register.** This is accepted behavior with no refresh
  grace period — refreshing the last (or only) Allow Site tab drops registration and a fresh
  REGISTER happens once the page reloads and becomes the Allow Site tab again.
- **The offscreen document cannot itself prompt for microphone permission.** `getUserMedia`
  prompts do not surface reliably from an offscreen document; microphone access must be granted
  from the Options page (Advanced → Test microphone) before registration can succeed.
- **Auto-answer never precedes a microphone grant.** Web SIP Phone will never fake a successful answer
  when the user has not granted microphone permission — an Agent First call with no microphone
  access fails rather than silently auto-answering without audio.
- **Single account, single call.** Only one SIP account and one concurrent SIP session are
  supported. An unexpected second INVITE while a session is active is rejected with `486 Busy
  Here`; the existing session is unaffected.
- **Account and TURN configuration changes take effect on the next runtime start, not
  immediately.** There is no hot credential reload mid-registration: after changing Domain,
  Account, Password, or TURN settings, close and reopen the last Allow Site tab (or use Retry on
  the dot) to force the SIP runtime to restart with the new configuration.
- **The privacy-policy URL on the About page is a placeholder** (`https://example.invalid/privacy`
  in `static/options.html`). The organization deploying this extension must replace it with a real
  policy URL before Chrome Web Store submission.
- **Store listing assets are not included.** Screenshots, promotional tiles, and other Chrome Web
  Store listing assets are not part of this deliverable; the deploying organization must produce
  them separately.
- **MV3 service-worker listener-registration timing should be watched during live testing.**
  Chrome requires event listeners (`chrome.runtime.onMessage`, `chrome.tabs.on*`, etc.) to be
  registered synchronously on service-worker startup to reliably survive the worker being woken
  by an event; this codebase registers its listeners after the first `await` in the service
  worker's init sequence. This has not caused a failure in testing, but it is a known deviation
  from the strict MV3 recommendation and is worth specifically watching for missed events (e.g. a
  tab-close or message arriving right as the worker wakes) during manual/live acceptance testing.
