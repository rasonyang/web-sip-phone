# Web SIP Phone — Privacy Policy

_Last updated: August 12, 2026_

Web SIP Phone is a Chrome extension that maintains a WebRTC SIP registration in your browser and
shows its connection status on websites you explicitly allow.

## What data the extension handles

- **SIP account settings** (domain, account name, password), the **allowed-sites list**, optional
  **TURN settings**, and the widget's last dragged position. These are stored locally on your
  device using `chrome.storage.local` and are never transmitted to the developer.
- **Microphone audio** is captured only to carry the audio of your own SIP calls. Audio and SIP
  signaling are transmitted exclusively to the SIP server **you configure** — never to the
  developer or any third party.
- A **diagnostic log** of connection events is kept in memory only (passwords and credentials are
  redacted), is discarded when the browser closes, and never leaves your device.

## What the extension does NOT do

- No data is sent to the developer. There are no analytics, telemetry, or tracking of any kind.
- No data is sold or shared with third parties.
- No browsing history is read. The extension runs only on the HTTPS sites you add to the
  Allow Sites list, and its content script only renders the status widget.

## Permissions

- `storage` — save your settings locally.
- `offscreen` — host the SIP/WebRTC engine required by Manifest V3.
- `scripting` / `tabs` — inject the status widget only into your allowed sites and register only
  while one of them is open.
- Per-site host access is requested at the moment you add a site, never at install time.

## Contact

Questions about this policy: open an issue at
<https://github.com/rasonyang/web-sip-phone/issues> or email <rason.yang@gmail.com>.
