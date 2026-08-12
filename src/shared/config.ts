export interface AccountConfig {
  domain: string;
  username: string;
  password: string;
}

export interface TurnConfig {
  enabled: boolean;
  url: string;
  username: string;
  credential: string;
}

export interface DotPosition {
  side: "left" | "right";
  /** Fraction of viewport height, 0–1. */
  y: number;
}

export interface WebSipPhoneConfig {
  account: AccountConfig | null;
  allowSites: string[];
  turn: TurnConfig | null;
  dotPosition: DotPosition | null;
}

export const DEFAULT_CONFIG: WebSipPhoneConfig = {
  account: null,
  allowSites: [],
  turn: null,
  dotPosition: null
};

export const DEFAULT_STUN = "stun:stun.l.google.com:19302";

export function isAccountComplete(a: AccountConfig | null): a is AccountConfig {
  return a !== null && a.domain.length > 0 && a.username.length > 0 && a.password.length > 0;
}

export function deriveEndpoints(a: AccountConfig): { sipUri: string; wssUrl: string } {
  return {
    sipUri: `sip:${a.username}@${a.domain}`,
    wssUrl: `wss://${a.domain}/`
  };
}

export function iceServers(turn: TurnConfig | null): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: DEFAULT_STUN }];
  if (turn && turn.enabled && turn.url) {
    servers.push({ urls: turn.url, username: turn.username, credential: turn.credential });
  }
  return servers;
}
