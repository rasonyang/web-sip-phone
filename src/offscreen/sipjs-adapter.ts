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
        peerConnectionConfiguration: { iceServers: config.iceServers }
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
