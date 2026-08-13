import { Registerer, UserAgent } from "sip.js";
import type { RuntimeConfig } from "../shared/messages.js";
import type { UaDelegate, UaFactory } from "./sip-runtime.js";

export const realUaFactory: UaFactory = {
  create(config: RuntimeConfig, delegate: UaDelegate) {
    const uri = UserAgent.makeURI(config.sipUri);
    if (!uri) {
      throw new Error("Invalid SIP URI derived from configuration");
    }
    const ua = new UserAgent({
      uri,
      // CRLF keepalive so a socket orphaned by system sleep is detected as dead within
      // seconds (a send on it fails) instead of lingering until TCP gives up.
      transportOptions: { server: config.wssUrl, keepAliveInterval: 20 },
      authorizationUsername: config.username,
      authorizationPassword: config.password,
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: config.iceServers },
        // SIP.js defaults to 5000ms, and it waits out the full timeout whenever any candidate
        // source never settles — a pseudo-interface from a VPN, an unreachable IPv6 route —
        // which is the common case. Since the answer SDP is only sent once this wait ends,
        // that default put ~5s of ringback between "answer" and the call going active.
        // 1000ms suits the LAN-first deployments this targets: host candidates are immediate
        // and STUN-derived srflx candidates typically arrive well inside it. The cost is real
        // but bounded: SIP signaling here is non-trickle, so any candidate gathered after the
        // cap never reaches the peer. Deployments that depend on TURN relay candidates across
        // heavy NAT may need this raised.
        iceGatheringTimeout: 1000
      },
      logBuiltinEnabled: false,
      delegate: {
        onConnect: () => delegate.onConnect(),
        onDisconnect: (error?: Error) => delegate.onDisconnect(error),
        onInvite: (invitation) => delegate.onInvite(invitation)
      }
    });
    // Tee raw inbound SIP messages to the runtime's liveness watchdog. Safe to wrap here:
    // UserAgent wires transport.onMessage exactly once, in its constructor.
    const upstream = ua.transport.onMessage;
    ua.transport.onMessage = (message: string): void => {
      delegate.onTransportMessage(message);
      upstream?.(message);
    };

    const registerer = new Registerer(ua);
    return { ua, registerer };
  }
};
