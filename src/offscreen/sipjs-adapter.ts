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
      transportOptions: { server: config.wssUrl },
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
    const registerer = new Registerer(ua);
    return { ua, registerer };
  }
};
