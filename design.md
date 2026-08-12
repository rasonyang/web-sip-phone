# Implementation Task: Web SIP Phone — Chrome Extension WebRTC Voice Link, Version 1

## 1. Goal

Build **Web SIP Phone**, a Chrome Extension WebRTC voice link that is as simple as possible.

Core positioning:

* Based on SIP.js and the BroadSoft SIP Remote Control Extension.
* Reference SIP.js PR: `https://github.com/onsip/SIP.js/pull/1118`
* Calls are controlled centrally by FreeSWITCH.
* The Chrome Extension is responsible for SIP registration, WebRTC audio, and call state execution.
* The user cannot initiate a call, answer, hang up, hold, resume, or mute from the Extension.
* Runs only on configured Allow Site pages.
* Shows a small draggable **voice connection status dot** (Web SIP Phone) on Allow Site pages.
* Web SIP Phone is a status indicator and fault entry point for the browser-side voice link (SIP, WSS, microphone, WebRTC media). It is **not** another agent softphone; the existing agent softphone bar on the business page owns all call-facing UI.
* Version 1 supports both FreeSWITCH-controlled outbound calls and normal inbound calls.

Do not expand this into a full softphone. Do not add a dial pad, contacts, call history, a CTI API, or any other extra features.

Do not duplicate anything the existing agent softphone bar already displays, including:

* Caller or callee numbers
* Inbound/outbound business information
* Call duration
* Agent status
* Answer, hangup, hold, resume, or mute controls

Call states such as `DIALING`, `RINGING`, `ACTIVE`, and `HELD` are still maintained in the internal state machine so that FreeSWITCH SIP control signaling executes correctly, but they are never expanded into a second softphone UI.

---

# 2. Development Principles

1. Prioritize simple, stable, verifiable functionality.
2. FreeSWITCH is the authoritative source of call control.
3. The Extension only executes the SIP control signaling emitted by FreeSWITCH.
4. The UI only displays voice-link (connection) state; it shows no call information and provides no call control buttons.
5. Use standard SIP, WebSocket, and WebRTC capabilities.
6. The BroadSoft Remote Control portion is based on SIP.js PR #1118.
7. If PR #1118 does not fully implement `Event: hold`, complete it within this project.
8. Do not depend on the moving HEAD of the PR branch; pin to an explicit commit.
9. Do not remotely load JavaScript, WebAssembly, or any other executable code.
10. All dependencies and icons are bundled into the Extension.

---

# 3. Tech Stack and Chrome Architecture

## 3.1 Base Technology

Use:

* TypeScript
* Chrome Extension Manifest V3
* SIP.js
* WebRTC
* WebSocket Secure
* Plain HTML/CSS, or a very lightweight UI implementation

Do not pull in a large UI framework for this small UI, unless the current repository already uses that framework.

Target browsers:

* Chrome 116 or later
* Desktop Chrome
* Firefox, Safari, and mobile browsers are out of scope

## 3.2 Extension Component Breakdown

Use the following architecture:

### Service Worker

Responsibilities:

* Extension lifecycle coordination
* Allow Site tab management
* Options configuration management
* Message routing between Content Scripts and the Offscreen Document
* Determining whether at least one Allow Site tab exists
* Determining whether the current tab is the last Allow Site
* Managing dynamic site permissions
* Creating and destroying the Offscreen Document

Do not run SIP.js long-term or hold a live WebRTC session in the Service Worker.

### Offscreen Document

Responsibilities:

* Runs the single global SIP.js User Agent
* Establishes SIP over WSS
* REGISTER / unregister
* Manages the single SIP Session
* Acquires the microphone
* Plays remote audio
* Handles INVITE, CANCEL, BYE, NOTIFY
* Handles `Event: talk`
* Handles `Event: hold`
* Maintains the global Runtime State and Call State
* Broadcasts state to the Service Worker

Globally, only the following are allowed:

* One SIP User Agent
* One SIP WebSocket
* One SIP registration
* One active SIP Session

### Content Script

Responsibilities:

* Injected only into the top-level page of an Allow Site
* Renders the Web SIP Phone status dot using Shadow DOM
* Displays the global voice-link state (SIP registration, WSS, microphone, media) — never call details
* Receives Service Worker broadcasts
* Handles expand (error/status panel), collapse, drag with edge snapping, and opening settings
* Registers a `beforeunload` leave confirmation when necessary

The Content Script must not:

* Hold the SIP password
* Run SIP.js
* Open a WebSocket
* Access the microphone directly
* Expose a SIP control API to the web page
* Listen for dial or control commands from the web page

### Options Page

Provides the configuration UI:

* Account
* Allow Sites
* Advanced
* About

---

# 4. Chrome Permission Requirements

Follow the principle of least privilege.

Expected requirements:

* `storage`
* `offscreen`
* `scripting`
* `tabs`
* Any other minimal permissions required

Allow Sites use dynamically requested `optional_host_permissions`.

Requesting the following by default is prohibited:

```text
<all_urls>
```

Request site permissions only for Allow Sites the user has explicitly added.

Inject the UI only into top-level pages, never into iframes.

---

# 5. Configuration UI

## 5.1 Account

An ordinary user only needs to see three account fields:

* Domain
* Account
* Password

Field definitions:

### Domain

Enter the hostname only, for example:

```text
voice.example.com
```

Do not require the user to enter:

* `sip:`
* `https://`
* `wss://`
* A port
* A path

Derived automatically:

```text
SIP URI = sip:<account>@<domain>
WSS URL = wss://<domain>/
WSS Port = 443
WSS Path = /
WebSocket Subprotocol = sip
```

The SIP WebSocket subprotocol must be used in the WebSocket handshake:

```text
Sec-WebSocket-Protocol: sip
```

### Account

The SIP username, for example:

```text
1001
```

### Password

The SIP Digest Authentication password.

The password field is masked by default, with an eye icon to reveal it temporarily.

The Account page provides:

* Save
* Sign Out / Clear Account
* A brief registration status indicator

Saving the configuration must not trigger registration immediately.

Registration is allowed only when at least one Allow Site tab exists.

## 5.2 Allow Sites

Allow Sites use exact hostname matching.

Example:

```text
crm.example.com
```

Matches:

```text
https://crm.example.com/*
```

Does not match:

```text
https://sub.crm.example.com/*
https://www.crm.example.com/*
https://example.com/*
```

Requirements:

* No wildcard support
* Subdomains are not included automatically
* No path-level matching
* One configuration entry per hostname
* Multiple hostnames can be configured
* Only HTTPS is supported by default
* Request the corresponding Chrome host permission when a site is added
* Stop injecting Web SIP Phone into a site when it is removed
* Revoke the corresponding permission where possible after a site is removed

The Allow Sites page provides:

* A hostname input field
* Add
* A list of configured sites
* Remove

## 5.3 Advanced

Google's public STUN server is configured by default:

```text
stun:stun.l.google.com:19302
```

Google is used only as the default STUN; no default TURN is provided.

The Advanced page provides optional TURN configuration:

* Enable TURN
* TURN URL
* TURN Username
* TURN Credential

Examples:

```text
turn:turn.example.com:3478
turns:turn.example.com:5349
```

Saving TURN settings affects subsequent calls only; it does not recover calls that have already failed.

A lightweight media connectivity test may be provided, but do not build a complex diagnostics platform.

## 5.4 About

Displays:

* Extension name
* Current version
* A short product description
* A Privacy Policy link
* The current SIP.js version or pinned commit

---

# 6. Allow Site and SIP Registration Lifecycle

## 6.1 Registration Conditions

The SIP Runtime starts only when all of the following hold:

1. The Account configuration is complete.
2. At least one Allow Site tab is open.
3. Microphone permission is available.

Flow:

```text
INACTIVE_NO_ALLOWED_SITE
→ CONNECTING
→ REGISTERING
→ READY
```

## 6.2 Opening the First Allow Site

When the first Allow Site tab opens:

1. Create the Offscreen Document.
2. Start the SIP.js User Agent.
3. Establish WSS.
4. REGISTER to FreeSWITCH.
5. Enter READY on successful registration.
6. Show the Web SIP Phone status dot on all Allow Site pages.

## 6.3 Multiple Tabs

All Allow Site tabs show and synchronize the same Web SIP Phone state.

Multiple tabs share:

* One SIP User Agent
* One registration state
* One Call State (internal)
* One error state

Closing some Allow Site tabs:

* Does not affect registration
* Does not affect the current call
* Does not create a new SIP Session

## 6.4 Closing the Last Allow Site

When there is no call:

1. Send unregister with REGISTER Expires set to 0.
2. Close the SIP WebSocket.
3. Destroy the SIP Runtime.
4. Enter `INACTIVE_NO_ALLOWED_SITE`.

When any of the following states is active:

* DIALING
* RINGING
* ACTIVE
* HELD

Use `beforeunload` to make a best effort to show the browser's native confirmation prompt when the last Allow Site page is closed, refreshed, or navigated away from.

The browser confirmation text cannot be customized.

If the user cancels leaving:

* The page stays
* The call continues
* SIP registration continues

If the user confirms leaving:

1. End the current call.
2. Unregister SIP.
3. Close WSS.
4. Stop media.
5. Destroy the SIP Runtime.

The following browser limitations must be accepted:

* The browser does not guarantee that `beforeunload` is shown in all cases
* It may not be shown if the user has not interacted with the page
* A browser crash or a forced system shutdown cannot guarantee a prompt

Unregistration and re-registration caused by a page refresh is acceptable; no refresh grace period is required.

---

# 7. SIP Call Model

Version 1 supports:

1. FreeSWITCH-controlled Agent First outbound calls.
2. Normal inbound calls.

The two are distinguished by whether the initial INVITE contains a valid `Answer-After` parameter.

---

# 8. FreeSWITCH-Controlled Outbound Calls

## 8.1 Call Flow

FreeSWITCH uses Agent First:

1. FreeSWITCH originates a call to the browser SIP account.
2. The INVITE carries the BroadSoft `Answer-After`.
3. The Extension recognizes it as a controlled outbound call.
4. The Extension enters DIALING (internal state only; not shown in the Web SIP Phone UI).
5. The Extension auto-answers the browser leg.
6. FreeSWITCH then calls the external destination number.
7. FreeSWITCH bridges the two call legs.
8. Once the destination answers, FreeSWITCH sends `Event: talk` within the browser dialog.
9. The Extension enters ACTIVE.

Typical header:

```text
Call-Info: <sip:...>;answer-after=0
```

Requirements:

* Header names and parameter names must be handled case-insensitively per SIP rules.
* `answer-after=0` means answer automatically and immediately.
* If a valid non-negative value is present, auto-answer after that number of seconds.
* If the `Answer-After` parameter is present but cannot be parsed, do not auto-answer; treat it as a normal inbound call and record a diagnostic log entry.

## 8.2 Outbound Call States

```text
READY
→ DIALING
→ ACTIVE
→ HELD
→ ACTIVE
→ ENDED
→ READY
```

Failure flow:

```text
READY
→ DIALING
→ FAILED
→ READY
```

## 8.3 DIALING to ACTIVE

Once the destination leg answers and the bridge completes, FreeSWITCH sends:

```text
NOTIFY
Event: talk
```

When the current state is DIALING, the Extension interprets this as:

```text
DIALING → ACTIVE
```

No additional custom state protocol is needed.

## 8.4 Outbound Call Failure

When the destination number is unreachable, busy, rejected, times out, or fails for any other reason:

* FreeSWITCH ends the browser leg.
* The Extension moves from DIALING to FAILED (internal state only).
* Web SIP Phone displays nothing for a call failure — call outcomes are the business softphone bar's responsibility.

Do not map any of the following into the UI:

* SIP response code
* Q.850 cause
* Busy
* No Answer
* Carrier failure
* Invalid number

Detailed reasons may only be written to the diagnostic log.

FAILED transitions back to READY after about 3 seconds (internal state machine only; no UI display).

---

# 9. Normal Inbound Calls

## 9.1 Inbound Detection

A normal inbound INVITE does not contain `Answer-After`.

On receipt:

```text
READY → RINGING
```

The Extension:

* Does not auto-answer
* Provides no local answer button
* Provides no reject button
* Maintains RINGING internally only; Web SIP Phone displays no ringing UI

## 9.2 FreeSWITCH Remote Answer

When FreeSWITCH decides to answer, it sends within the corresponding SIP dialog:

```text
NOTIFY
Event: talk
```

When the Extension receives this event in the RINGING state:

1. Answer the SIP INVITE.
2. Establish WebRTC audio.
3. Enter ACTIVE.

State:

```text
RINGING → ACTIVE
```

## 9.3 Inbound Call Cancellation

If a SIP CANCEL arrives before answering:

```text
RINGING → ENDED → READY
```

This is an internal transition only; Web SIP Phone displays nothing.

Version 1 does not provide:

* Missed Call
* Inbound call records
* Call back
* Local reject
* Local answer

Inbound call timeout is controlled entirely by FreeSWITCH.

---

# 10. BroadSoft Remote Control

## 10.1 Talk

Uses:

```text
NOTIFY
Event: talk
```

Behavior depends on the current state:

| Current state    | Behavior                                    |
| ---------------- | ------------------------------------------- |
| DIALING          | Mark the destination as answered, go ACTIVE |
| RINGING          | Answer the inbound call, go ACTIVE          |
| HELD             | Resume the call, go ACTIVE                  |
| ACTIVE           | Idempotent success; do not re-execute       |
| ENDED            | Ignore                                      |
| No matching dialog | Reject or ignore and log                  |

FreeSWITCH is responsible for sending valid Talk events under normal conditions.

The client performs only basic defensive validation.

## 10.2 Hold

Uses the BroadSoft Access-Side Extension:

```text
NOTIFY
Event: hold
```

Behavior:

```text
ACTIVE → HELD
```

Requirements:

* It must belong to the current SIP dialog.
* If already HELD, treat a repeated Hold as idempotent success.
* Hold received in the RINGING, DIALING, or ENDED state is not executed.
* A Hold with no matching dialog must not affect the existing session.
* Handle the NOTIFY response according to the BroadSoft specification.
* If SIP.js PR #1118 does not implement Hold completely, add the missing types, parsing, state handling, and tests.

## 10.3 Resume

Resume uniformly uses:

```text
NOTIFY
Event: talk
```

State:

```text
HELD → ACTIVE
```

Do not add an extra `Event: resume`.

---

# 11. Hangup

Do not design a custom Hangup NOTIFY.

Use standard SIP:

### Before answering

FreeSWITCH sends:

```text
CANCEL
```

### After answering

FreeSWITCH sends:

```text
BYE
```

The Extension:

* Responds correctly to the SIP messages
* Stops media
* Cleans up the session
* Updates the internal Call State
* Keeps the SIP registration, unless the last Allow Site has been closed

The UI provides no local hangup button.

---

# 12. Multiple Call Handling

The server is responsible for ensuring that multiple calls are never sent to the same account simultaneously.

Version 1 does not implement:

* Call Waiting
* Multiple calls
* Queuing
* Session switching
* User-selected answering

The client must still keep the most basic defensive handling:

If already in one of:

* RINGING
* DIALING
* ACTIVE
* HELD

and a second independent INVITE unexpectedly arrives:

```text
486 Busy Here
```

Do not disrupt the current session.

---

# 13. State Model

Keep Runtime State and Call State separate.

## 13.1 Runtime State

```text
UNCONFIGURED
INACTIVE_NO_ALLOWED_SITE
CONNECTING
REGISTERING
READY
REGISTRATION_FAILED
CONNECTION_LOST
MICROPHONE_BLOCKED
MEDIA_FAILED
```

## 13.2 Call State

```text
IDLE
DIALING
RINGING
ACTIVE
HELD
FAILED
ENDED
```

## 13.3 State Authority

* Runtime State is managed by the Extension.
* Call control is driven by FreeSWITCH SIP signaling.
* Call State is internal-only: it drives SIP execution and `beforeunload` protection, never Web SIP Phone UI rendering.
* Web pages must not be able to modify Call State directly.
* UI clicks must not modify Call State directly.
* All state transitions are implemented in one place, not scattered across UI components.

---

# 14. Web SIP Phone UI

Web SIP Phone appears on business pages as a draggable **WebRTC voice connection status dot** that reflects the health of the browser-side SIP, WSS, microphone, and WebRTC media links.

> Core principle: Web SIP Phone is a status indicator and fault entry point for the browser WebRTC voice link — not another agent softphone.

## 14.1 Overall Style

UI requirements:

* Minimal
* Small
* Lightweight
* Non-intrusive to the host page
* White or light-colored card
* Rounded corners
* Subtle shadow
* System fonts
* Bundled SVG icons
* Not polluted by host page CSS
* Style isolation via Shadow DOM
* State is not conveyed by color alone
* Supports keyboard focus and basic accessibility attributes

UI copy is in English for version 1.

## 14.2 Position and Dragging

* Default dock: the middle-lower area of the page's right edge.
* Supports dragging; on release it snaps to the nearest left or right page edge.
* The last dragged position is saved globally and restored; per-site positions are not needed.
* Web SIP Phone needs a sufficiently high z-index, but must not interfere with Chrome's own UI.

## 14.3 Normal State (Collapsed)

Under normal conditions Web SIP Phone always stays collapsed, showing only a small voice-connection status icon.

It must not duplicate anything the existing agent softphone bar already shows:

* Caller or callee numbers
* Inbound/outbound business information
* Call duration
* Agent status
* Answer, hangup, hold, resume, or mute controls

`DIALING`, `RINGING`, `ACTIVE`, and `HELD` remain internal state-machine states used to execute FreeSWITCH SIP control signaling correctly; they are never expanded into a second softphone UI.

## 14.4 Error State (Auto-Expand)

Web SIP Phone auto-expands only when one of the following faults occurs:

* SIP registration failure
* WSS connection lost or reconnect failure
* Microphone permission denied or device unavailable
* ICE, STUN, TURN, or WebRTC media connection failure

When expanded it shows only:

* A concise error name
* One line of essential explanation
* One clear recovery entry point

Examples:

| Error | Action |
| ----- | ------ |
| `Registration failed` | `Open Settings` |
| `Voice connection lost` | `Retry` |
| `Microphone unavailable` | `Enable microphone` |
| `Media connection failed` | `Configure TURN` |

Do not show SIP status codes, Q.850 causes, protocol stacks, or any other developer-facing error details.

## 14.5 Voice Connection Panel

Clicking the collapsed status dot opens a concise `Voice connection` status panel.

The panel shows only the status of:

* SIP Registration
* WebSocket
* Microphone
* Media

The panel must not provide any call control buttons, and must not display:

* Answer
* Reject
* Hangup
* Hold
* Resume
* Mute
* DTMF
* Dial Pad
* Numbers, call duration, or any call business information

A settings entry point and a collapse/close control are allowed.

## 14.6 Multi-Tab Consistency

All Allow Site tabs show and synchronize the same Web SIP Phone state.

---

# 15. Remote Party Identity

Web SIP Phone does not display remote party identity (display name, SIP URI user, or number) — the business softphone bar owns that.

Remote party information may appear masked in the diagnostic log only, and is never used as a basis for call control.

Do not implement number formatting, contact matching, or CRM lookups in version 1.

---

# 16. Error UX

Errors are the only condition under which Web SIP Phone auto-expands (see 14.4).

Error display principles:

* Short copy
* Show only the single most important error at a time
* A concise error name, one line of essential explanation, one clear recovery entry point
* No technical stack traces
* No SIP status codes, Q.850 causes, or protocol details shown to ordinary users

## 16.1 Registration Failure

Display:

```text
Registration failed
Check account settings
```

Action:

```text
Open Settings
```

Clicking opens the Account page.

## 16.2 WSS Disconnection

While reconnecting automatically:

```text
Reconnecting…
```

On persistent failure:

```text
Voice connection lost
```

Action:

```text
Retry
```

Keep reconnecting with a backoff strategy as long as an Allow Site still exists.

Stop reconnecting when there is no Allow Site.

## 16.3 Media Failure

Display:

```text
Media connection failed
```

Action:

```text
Configure TURN
```

Clicking opens:

```text
Options → Advanced → TURN
```

## 16.4 Microphone Failure

Display:

```text
Microphone unavailable
```

Action:

```text
Enable microphone
```

Opens the microphone settings or the permission guidance in the options page.

## 16.5 Error Priority

When multiple errors occur at once, display them in this priority order:

```text
MICROPHONE_BLOCKED
MEDIA_FAILED
REGISTRATION_FAILED
CONNECTION_LOST
```

Keep all errors in the diagnostic log.

---

# 17. Microphone and Audio

Open the Options page after first install and guide the user to:

1. Enter the account.
2. Configure an Allow Site.
3. Grant microphone permission.
4. Complete a simple microphone test.
5. Save.

Requirements:

* FreeSWITCH must not be allowed to bypass Chrome's microphone permission.
* Never fake a successful answer when the user has not granted microphone permission.
* Show a clear error when the microphone is unavailable.
* Audio uses standard WebRTC capabilities.
* Enable the browser-provided features by default:

  * Echo Cancellation
  * Noise Suppression
  * Auto Gain Control

Version 1 does not provide:

* Microphone selection
* Speaker selection
* A local mute button
* Input volume control
* Output volume control

---

# 18. STUN/TURN and ICE

Default ICE server:

```text
stun:stun.l.google.com:19302
```

No TURN is configured by default.

When ICE fails or no media path is available:

1. Enter MEDIA_FAILED.
2. The UI shows `Media connection failed`.
3. Offer `Configure TURN`.
4. Do not redial automatically.
5. Do not recover the failed call.

TURN credentials are stored only locally in the Extension.

---

# 19. Local Configuration and Security

There are no additional enterprise encryption or compliance requirements, but general security rules must be followed.

Requirements:

* Use WSS/TLS.
* Store the SIP password in `chrome.storage.local`.
* Store the TURN credential in `chrome.storage.local`.
* Do not use `chrome.storage.sync` for passwords.
* Do not invent weak encryption or obfuscation schemes.
* Do not send the password to the Content Script.
* Do not put the password in the DOM.
* Do not expose the password to web pages.
* Do not log the SIP Authorization header.
* Do not log the Proxy-Authorization header.
* Do not log the SIP password.
* Do not log the TURN credential.
* Logs may contain the Call-ID, state, timestamps, and masked numbers.
* Clearing the account also clears both the SIP and TURN credentials.
* The Chrome Web Store package must not hard-code customer accounts, passwords, or server configuration.

---

# 20. Content Script Security Boundary

The following must not be implemented:

* Dialing via `window.postMessage`
* Call control from page JavaScript
* Dialing by clicking a number in the DOM
* An externally connectable call interface
* Web pages reading full SIP messages
* Web pages reading the Call-ID
* Web pages reading the account configuration
* Web pages triggering Answer, Hold, or Hangup

The Content Script receives only masked display state.

---

# 21. Out of Scope for Version 1

Explicitly do not implement:

* Dial pad
* User-initiated Make Call
* Local Answer
* Local Reject
* Local Hangup
* Local Hold
* Local Resume
* Local Mute
* DTMF
* Contacts
* Call history
* Missed Call
* Call back
* Transfer
* Three-way conferencing
* Multiple accounts
* Concurrent calls
* Video
* Call recording
* CRM API
* Click to Call
* Number detection in pages
* Device switching
* Local ringtone playback
* Custom ringtone configuration
* Firefox or Safari support

Do not add these features on your own initiative.

---

# 22. Testing Requirements

## 22.1 Unit Tests

Cover at least:

### Header parsing

* INVITE with `answer-after=0`
* INVITE with another non-negative value
* Parameter case variations
* Header name case variations
* Parameter absent
* Malformed parameter
* Negative parameter value

### State machine

* READY → DIALING
* READY → RINGING
* DIALING → ACTIVE
* RINGING → ACTIVE
* ACTIVE → HELD
* HELD → ACTIVE
* DIALING → FAILED
* RINGING → ENDED
* ACTIVE → ENDED
* HELD → ENDED
* Repeated Talk
* Repeated Hold
* Talk in an invalid state
* Hold in an invalid state

### Allow Site

* Exact hostname match
* Subdomain does not match
* Similar domain does not match
* Multiple Allow Sites
* First tab opened
* An intermediate tab closed
* The last tab closed
* Multiple Chrome windows scenario

### Multiple calls

* A second INVITE arrives while a session exists
* 486 is returned
* The current session is unaffected

### Error priority

* Microphone error overrides media error
* Media error overrides registration error
* Registration error overrides connection error

## 22.2 Integration Tests

Using a mock SIP transport or a controllable SIP test environment, cover:

1. REGISTER success.
2. REGISTER failure.
3. WSS disconnect and reconnect.
4. INVITE + Answer-After auto-answer.
5. A normal INVITE showing RINGING.
6. Answering after Talk is received while RINGING.
7. Entering ACTIVE after Talk is received while DIALING.
8. Hold received while ACTIVE.
9. Talk received while HELD.
10. CANCEL received while RINGING.
11. BYE received while ACTIVE.
12. BYE received while HELD.
13. ICE failure.
14. Subsequent calls working after TURN is configured.
15. Multi-tab state synchronization.

## 22.3 FreeSWITCH Live Acceptance

Verify in a real FreeSWITCH environment:

* SIP over WSS
* Two-way WebRTC audio
* REGISTER / unregister
* Agent First outbound calls
* Normal inbound calls
* BroadSoft `Event: talk`
* BroadSoft `Event: hold`
* CANCEL
* BYE
* Google STUN
* Custom TURN
* Multiple tabs
* Closing the last Allow Site
* Configuration restored after a Chrome restart

---

# 23. Version 1 Acceptance Criteria

All of the following must be satisfied:

1. The user only needs to configure Domain, Account, and Password to complete account setup.
2. WSS defaults to `wss://<domain>/`, port 443, subprotocol `sip`.
3. No registration occurs when there is no Allow Site page.
4. Registration happens automatically once the first Allow Site is opened.
5. Multiple Allow Site tabs produce only one REGISTER.
6. All Allow Site tabs show and synchronize the same Web SIP Phone state.
7. When the INVITE contains Answer-After, the internal state enters DIALING and the call is auto-answered.
8. When the INVITE does not contain Answer-After, the internal state enters RINGING and no auto-answer occurs.
9. Talk received while RINGING answers the call and enters ACTIVE.
10. Talk received while DIALING enters ACTIVE.
11. Hold received while ACTIVE enters HELD.
12. Talk received while HELD returns to ACTIVE.
13. CANCEL received while RINGING ends the call.
14. BYE received while ACTIVE or HELD ends the call.
15. A DIALING failure produces no Web SIP Phone UI; the detailed reason goes to the diagnostic log only.
16. An unexpected second INVITE returns 486 Busy Here.
17. Web SIP Phone stays collapsed as a small status dot in all normal states, including during calls, and never shows numbers, call duration, or call controls.
18. Web SIP Phone auto-expands only on registration failure, WSS loss, microphone failure, or media failure, showing an error name, one line of explanation, and one recovery action.
19. Web SIP Phone docks at the middle-lower right edge by default.
20. Web SIP Phone supports dragging with left/right edge snapping, persists the last position, and clicking it opens the `Voice connection` panel showing only SIP Registration, WebSocket, Microphone, and Media status.
21. The UI contains no call control buttons.
22. Registration failure, connection loss, media failure, and microphone failure all have concise messages.
23. Media failure offers a Configure TURN entry point.
24. Closing the last Allow Site during a call makes a best effort to show a leave confirmation.
25. After the user confirms leaving, the call is hung up, SIP is unregistered, and WSS is closed.
26. Passwords and authentication headers never appear in logs.
27. The Extension does not request `<all_urls>`.
28. The Extension does not remotely load executable code.
29. It can be packaged as a publicly published Chrome Web Store build.
30. All automated tests pass.

---

# 24. Deliverables

On completion, deliver:

1. Runnable Chrome Extension source code.
2. Manifest V3 configuration.
3. A pinned SIP.js fork or pinned-commit dependency.
4. The BroadSoft Talk/Hold implementation.
5. The Options page.
6. Allow Site management.
7. The Offscreen SIP Runtime.
8. The multi-tab Web SIP Phone status dot and `Voice connection` panel.
9. Unit and integration tests.
10. A README.
11. FreeSWITCH integration notes.
12. Chrome Web Store packaging instructions.
13. A statement of known limitations.
14. A loadable unpacked Extension build directory.
15. A command that generates the store-submittable zip package.

The README must contain at least:

* Install and build commands
* Steps to load an unpacked Extension in Chrome
* FreeSWITCH WSS/WebRTC prerequisites
* SIP account configuration
* Allow Site configuration
* Microphone authorization
* STUN/TURN configuration
* How to test Talk/Hold
* Common error troubleshooting
* Test commands

---

# 25. Execution Approach

Before writing code:

1. Inspect the current repository structure and existing tech stack.
2. Check whether Chrome Extension, SIP.js, or WebRTC code already exists.
3. Review the actual implementation in SIP.js PR #1118.
4. Identify which BroadSoft capabilities the PR already supports and which are missing.
5. Present a brief implementation plan.
6. Do not repeatedly ask about questions already answered in these requirements.

During implementation:

1. Build the base Extension architecture first.
2. Then configuration and Allow Sites.
3. Then SIP registration.
4. Then DIALING/RINGING.
5. Then Talk/Hold.
6. Then the UI and error states.
7. Finally tests and documentation.
8. Run the relevant tests after each stage.
9. Do not introduce complex abstractions beyond version 1's scope for the sake of "architectural completeness".
10. Do not add any call feature that was not explicitly requested.

After completion, output:

* An implementation summary
* A list of modified files
* An architecture description
* A description of the SIP state machine
* Test commands and results
* FreeSWITCH live test steps
* Known limitations
* Outstanding items

If any requirement turns out to be constrained by Chrome or SIP.js capabilities, state the limitation explicitly and implement the closest verifiable alternative — do not silently change the requirement.
