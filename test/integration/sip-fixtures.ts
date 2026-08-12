const CRLF = "\r\n";

export function header(raw: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  return re.exec(raw)?.[1]?.trim() ?? "";
}

export function isRequest(raw: string, method: string): boolean {
  return raw.startsWith(`${method} `);
}

let branchCounter = 0;

export const FAKE_SDP = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "c=IN IP4 127.0.0.1",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 0",
  "a=sendrecv",
  ""
].join(CRLF);

function withHeaders(lines: string[], body: string): string {
  return [...lines, `Content-Length: ${body.length}`, "", body].join(CRLF);
}

/** Build a response to a client request by copying its dialog-identifying headers. */
export function replyTo(
  raw: string,
  code: number,
  reason: string,
  opts: { toTag?: string; extraHeaders?: string[]; body?: string; contact?: string } = {}
): string {
  const body = opts.body ?? "";
  let to = header(raw, "To");
  if (opts.toTag && !/;tag=/.test(to)) {
    to = `${to};tag=${opts.toTag}`;
  }
  const lines = [
    `SIP/2.0 ${code} ${reason}`,
    `Via: ${header(raw, "Via")}`,
    `From: ${header(raw, "From")}`,
    `To: ${to}`,
    `Call-ID: ${header(raw, "Call-ID")}`,
    `CSeq: ${header(raw, "CSeq")}`,
    ...(opts.contact ? [`Contact: ${opts.contact}`] : []),
    ...(opts.body ? ["Content-Type: application/sdp"] : []),
    ...(opts.extraHeaders ?? [])
  ];
  return withHeaders(lines, body);
}

export interface ServerDialog {
  callId: string;
  serverTag: string;
  clientTag?: string;
  /** The client's Contact URI, from its 200 OK (or from its 180 Ringing for early-dialog use). */
  clientContact?: string;
  cseq: number;
  clientUser: string;
  domain: string;
  /** Via branch of the original INVITE; CANCEL must reuse it to match the same transaction. */
  inviteBranch: string;
}

/** Server-initiated INVITE (FreeSWITCH → browser). */
export function serverInvite(opts: { user: string; domain: string; callInfo?: string }): {
  raw: string;
  dialog: ServerDialog;
} {
  const callId = `it-${++branchCounter}-${Math.floor(performance.now())}`;
  const serverTag = `srv${branchCounter}`;
  const inviteBranch = `z9hG4bK-it-${++branchCounter}`;
  const lines = [
    `INVITE sip:${opts.user}@${opts.domain} SIP/2.0`,
    `Via: SIP/2.0/WSS mock.invalid;branch=${inviteBranch}`,
    `Max-Forwards: 70`,
    `From: <sip:freeswitch@${opts.domain}>;tag=${serverTag}`,
    `To: <sip:${opts.user}@${opts.domain}>`,
    `Call-ID: ${callId}`,
    `CSeq: 1 INVITE`,
    `Contact: <sip:freeswitch@mock.invalid;transport=wss>`,
    ...(opts.callInfo ? [`Call-Info: ${opts.callInfo}`] : []),
    `Content-Type: application/sdp`
  ];
  return {
    raw: withHeaders(lines, FAKE_SDP),
    dialog: { callId, serverTag, cseq: 1, clientUser: opts.user, domain: opts.domain, inviteBranch }
  };
}

/** Learn the client's dialog tag + Contact from an early (1xx) or final (2xx) client response. */
export function learnClientTag(response: string, dialog: ServerDialog): void {
  const to = header(response, "To");
  const tag = /;tag=([^;]+)/.exec(to)?.[1];
  if (tag) {
    dialog.clientTag = tag;
  }
  const contact = /<([^>]+)>/.exec(header(response, "Contact"))?.[1];
  if (contact) {
    dialog.clientContact = contact;
  }
}

/** Call after the client's 200 OK to the INVITE: learns the client tag, returns the ACK. */
export function ackFor(ok200: string, dialog: ServerDialog): string {
  learnClientTag(ok200, dialog);
  const target = dialog.clientContact ?? `sip:${dialog.clientUser}@${dialog.domain}`;
  const lines = [
    `ACK ${target} SIP/2.0`,
    `Via: SIP/2.0/WSS mock.invalid;branch=z9hG4bK-ack-${++branchCounter}`,
    `Max-Forwards: 70`,
    `From: <sip:freeswitch@${dialog.domain}>;tag=${dialog.serverTag}`,
    `To: <sip:${dialog.clientUser}@${dialog.domain}>;tag=${dialog.clientTag}`,
    `Call-ID: ${dialog.callId}`,
    `CSeq: 1 ACK`
  ];
  return withHeaders(lines, "");
}

/** In-dialog request from the server (NOTIFY / BYE / CANCEL). */
export function inDialogRequest(
  dialog: ServerDialog,
  method: "NOTIFY" | "BYE",
  opts: { extraHeaders?: string[]; body?: string } = {}
): string {
  dialog.cseq++;
  const target = dialog.clientContact ?? `sip:${dialog.clientUser}@${dialog.domain}`;
  const lines = [
    `${method} ${target} SIP/2.0`,
    `Via: SIP/2.0/WSS mock.invalid;branch=z9hG4bK-${method}-${++branchCounter}`,
    `Max-Forwards: 70`,
    `From: <sip:freeswitch@${dialog.domain}>;tag=${dialog.serverTag}`,
    `To: <sip:${dialog.clientUser}@${dialog.domain}>${dialog.clientTag ? `;tag=${dialog.clientTag}` : ""}`,
    `Call-ID: ${dialog.callId}`,
    `CSeq: ${dialog.cseq} ${method}`,
    ...(opts.extraHeaders ?? [])
  ];
  return withHeaders(lines, opts.body ?? "");
}

export function notify(dialog: ServerDialog, event: "talk" | "hold"): string {
  return inDialogRequest(dialog, "NOTIFY", {
    extraHeaders: [`Event: ${event}`, `Subscription-State: active`]
  });
}

/** CANCEL matches the original INVITE: same Via branch, same CSeq number as the INVITE. */
export function cancel(dialog: ServerDialog): string {
  const lines = [
    `CANCEL sip:${dialog.clientUser}@${dialog.domain} SIP/2.0`,
    `Via: SIP/2.0/WSS mock.invalid;branch=${dialog.inviteBranch}`,
    `Max-Forwards: 70`,
    `From: <sip:freeswitch@${dialog.domain}>;tag=${dialog.serverTag}`,
    `To: <sip:${dialog.clientUser}@${dialog.domain}>`,
    `Call-ID: ${dialog.callId}`,
    `CSeq: 1 CANCEL`
  ];
  return withHeaders(lines, "");
}
