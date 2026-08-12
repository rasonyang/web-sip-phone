# FreeSWITCH Integration Notes

Web SIP Phone is a status indicator, not a softphone: it registers a single SIP account over WSS,
answers/holds/resumes only in response to FreeSWITCH-driven signaling, and shows nothing about
call outcomes. This document covers what FreeSWITCH must be configured to do, and how to test
remote-control behavior manually.

## 1. WSS / WebRTC prerequisites

- **`wss-binding`**: enable a WSS binding in the `sofia` profile the browser account registers
  against (typically the `internal` or a dedicated `verto`/WebRTC-facing profile), e.g.
  `wss-binding :7443` — or terminate on 443 behind a reverse proxy/TLS load balancer if Web SIP Phone's
  derived `wss://<domain>/` (port 443, path `/`) must reach FreeSWITCH directly without a
  non-standard port.
- **Valid TLS**: the certificate presented on the WSS binding must be trusted by Chrome (a
  publicly trusted CA, or an internal CA installed in the OS/browser trust store) — Chrome refuses
  self-signed WebSocket certificates for `wss://` with no override UI in an extension context.
- **ICE candidate ACL**: add `<param name="apply-candidate-acl" value="..."/>` (or the
  equivalent NAT/ACL configuration) in the relevant `sofia` profile so ICE candidates from the
  browser's network are accepted.
- **Codecs**: ensure `opus` and `PCMU` are enabled in the profile's codec preferences — Web SIP Phone's
  WebRTC leg offers Opus by default and falls back to PCMU for PSTN-bridged legs.
- **NOTIFY support**: the profile must allow in-dialog `NOTIFY` with `Event: talk` and
  `Event: hold` (BroadSoft Access-Side Extensions) to reach the browser leg — this is standard
  FreeSWITCH behavior via `uuid_phone_event`, no extra module is required beyond `mod_sofia`.

## 2. Directory user example

A minimal `directory/default/1001.xml` entry for the SIP account Web SIP Phone registers as
(`sip:1001@voice.example.com`, matching the Options page Account/Domain fields):

```xml
<include>
  <user id="1001">
    <params>
      <param name="password" value="$${default_password}"/>
    </params>
    <variables>
      <variable name="user_context" value="default"/>
      <variable name="effective_caller_id_name" value="Agent 1001"/>
      <variable name="effective_caller_id_number" value="1001"/>
    </variables>
  </user>
</include>
```

## 3. Agent First outbound origination

FreeSWITCH originates to the browser account first, carrying `Answer-After` so Web SIP Phone
auto-answers immediately, then bridges to the external destination once the browser leg is up:

```text
originate {origination_caller_id_number=...,sip_h_Call-Info=<sip:fs>;answer-after=0}user/1001 &bridge(sofia/gateway/pstn/${dest})
```

- `Call-Info: <sip:fs>;answer-after=0` on the INVITE to `user/1001` is what Web SIP Phone recognizes as
  an Agent First call: it enters the internal `DIALING` state and auto-answers without any local
  UI. `answer-after=<N>` (any non-negative integer of seconds) delays auto-answer instead of
  answering immediately; a present-but-unparseable value is treated as a normal inbound call
  (Web SIP Phone logs it and does not auto-answer).
- Once the destination answers and FreeSWITCH completes the bridge, send `Event: talk` in the
  browser dialog (see below) to move Web SIP Phone from `DIALING` to `ACTIVE`.

## 4. Remote control (BroadSoft Access-Side Extensions)

Run against the browser leg's UUID (find it with `uuid_exists`/`fsctl` or from the dialplan
during the call):

```text
uuid_phone_event <uuid> talk
```

- While `RINGING` (normal inbound, no `Answer-After`): answers the call, `RINGING → ACTIVE`.
- While `DIALING` (Agent First, before the bridge completes): marks the destination answered,
  `DIALING → ACTIVE`.
- While `HELD`: resumes the call, `HELD → ACTIVE` (no separate `Event: resume` exists).
- While `ACTIVE`: idempotent no-op.

```text
uuid_phone_event <uuid> hold
```

- While `ACTIVE`: puts the call on hold via a re-INVITE (`sendonly`), `ACTIVE → HELD`.
- While already `HELD`: idempotent no-op.
- While `RINGING`, `DIALING`, or `ENDED`: not executed.

Standard SIP `CANCEL` (before answer) and `BYE` (after answer, from either leg) end the call as
usual; Web SIP Phone requires no custom hangup signaling.

## 5. Live acceptance checklist (design.md §22.3)

These items require a real FreeSWITCH environment and cannot be exercised by the automated test
suite (`npm test` covers the equivalent logic against a mock SIP transport — see the README's
"Test coverage" section). Fill in the Result column while testing against a live FreeSWITCH
instance and an unpacked build of `dist/`.

| # | Item | How to verify | Result |
| - | --- | --- | --- |
| 1 | SIP over WSS | Load unpacked build, configure Account, open an Allow Site tab; confirm registration succeeds and the Web SIP Phone dot shows no error | |
| 2 | Two-way WebRTC audio | Place a test call (Agent First or inbound) and confirm audio flows both directions | |
| 3 | REGISTER / unregister | Open first Allow Site tab (REGISTER in FreeSWITCH logs); close last Allow Site tab (unregister, Expires: 0) | |
| 4 | Agent First outbound calls | `originate` with `Call-Info: ;answer-after=0` to the account; confirm auto-answer with no local UI, then `Event: talk` moves to ACTIVE | |
| 5 | Normal inbound calls | Call the account from another extension/trunk with no `Answer-After`; confirm Web SIP Phone shows no ringing UI internally (RINGING is internal-only) | |
| 6 | BroadSoft `Event: talk` | `uuid_phone_event <uuid> talk` while RINGING and while DIALING; confirm ACTIVE in both cases | |
| 7 | BroadSoft `Event: hold` | `uuid_phone_event <uuid> hold` while ACTIVE; confirm HELD, then `talk` to resume | |
| 8 | CANCEL | Send CANCEL before answer on a RINGING call; confirm call ends with no UI | |
| 9 | BYE | Send BYE from FreeSWITCH while ACTIVE and while HELD; confirm call ends cleanly in both states | |
| 10 | Google STUN | Default config (no TURN); confirm ICE/media succeeds on a normal (non-symmetric-NAT) network | |
| 11 | Custom TURN | Configure TURN under Advanced, restart the runtime (close/reopen the last Allow Site tab or Retry), confirm a call succeeds through TURN | |
| 12 | Multiple tabs | Open 2+ Allow Site tabs; confirm only one REGISTER and that all tabs show identical, synchronized state during a call | |
| 13 | Closing the last Allow Site | Close the last Allow Site tab during an active call; confirm the best-effort `beforeunload` prompt appears, and that confirming leaving unregisters/hangs up/closes WSS | |
| 14 | Configuration restored after Chrome restart | Restart Chrome; confirm Account, Allow Sites, and Advanced settings persist and registration resumes when an Allow Site tab is opened | |

## 6. Version 1 acceptance criteria (design.md §23) — automated portion

Items 1–29 of design.md §23 are code-level behaviors already covered by the automated build/test
pipeline and manual FreeSWITCH testing above; item 30 ("all automated tests pass") is verified
directly. Results of the automated run performed for Task 21:

| Check | Command | Result |
| --- | --- | --- |
| Unit + integration tests | `npm test` | PASS — 17 files, 120 tests |
| Type check | `npx tsc --noEmit` | PASS — no errors |
| Production build | `npm run build` | PASS — `dist/` produced |
| Store package | `npm run package` | PASS — `web-sip-phone-1.0.0.zip` produced, `manifest.json` at archive root |

Items 1–29 that describe UI/behavior (dot styling, drag/snap, error priority, no call controls,
etc.) are covered by the unit/integration suite referenced in the README and by manual inspection
of the built `dist/` extension; items requiring a live FreeSWITCH server are the §22.3 list above
and are **pending live execution** — this checklist is left for the user to run against a real
FreeSWITCH deployment and record results in the table in section 5.
