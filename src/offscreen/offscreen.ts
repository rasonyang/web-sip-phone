import { isMsg, type Msg } from "../shared/messages.js";
import { realUaFactory } from "./sipjs-adapter.js";
import { SipRuntime } from "./sip-runtime.js";

const audio = document.getElementById("remote-audio") as HTMLAudioElement;

const runtime = new SipRuntime({
  factory: realUaFactory,
  audio,
  onStatus: (status) => {
    const msg: Msg = { target: "background", type: "offscreen/status", status };
    void chrome.runtime.sendMessage(msg).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isMsg(raw) || raw.target !== "offscreen") {
    return false;
  }
  switch (raw.type) {
    case "runtime/start":
      runtime
        .start(raw.config)
        .then(() => sendResponse(true))
        .catch((e) => {
          console.warn("[WebSipPhone] runtime start failed", e);
          sendResponse(false);
        });
      return true;
    case "runtime/stop":
      runtime
        .stop()
        .then(() => sendResponse(true))
        .catch((e) => {
          console.warn("[WebSipPhone] runtime stop failed", e);
          sendResponse(false);
        });
      return true;
    case "runtime/retry":
      runtime.retry();
      sendResponse(true);
      return false;
  }
  return false;
});
