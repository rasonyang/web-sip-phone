import { FAKE_SDP } from "./sip-fixtures.js";

type Modifier = (d: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>;

/** Minimal SDH: no WebRTC in Node. Applies modifiers so hold/resume SDP rewriting is observable. */
export class FakeSDH {
  static created: FakeSDH[] = [];
  /** When set, getDescription() waits on it — models ICE gathering that outlasts a CANCEL. */
  static gate: Promise<void> | null = null;
  lastLocalSdp = "";
  peerConnection = undefined; // call-session tolerates a missing peerConnection

  constructor() {
    FakeSDH.created.push(this);
  }

  async getDescription(
    _options?: unknown,
    modifiers?: Modifier[]
  ): Promise<{ body: string; contentType: string }> {
    await FakeSDH.gate;
    let desc: RTCSessionDescriptionInit = { type: "offer", sdp: FAKE_SDP };
    for (const m of modifiers ?? []) {
      desc = await m(desc);
    }
    this.lastLocalSdp = desc.sdp ?? "";
    return { body: this.lastLocalSdp, contentType: "application/sdp" };
  }

  setDescription(_sdp: string): Promise<void> {
    return Promise.resolve();
  }

  hasDescription(contentType: string): boolean {
    return contentType === "application/sdp";
  }

  sendDtmf(): boolean {
    return false;
  }

  close(): void {}
}

export const fakeSdhFactory = () => new FakeSDH() as never;
