import { isMsg, type Msg } from "../shared/messages.js";
import { MicMeter } from "./mic-meter.js";
import { realUaFactory } from "./sipjs-adapter.js";
import { SipRuntime } from "./sip-runtime.js";

const audio = document.getElementById("remote-audio") as HTMLAudioElement;

const send = (msg: Msg): void => void chrome.runtime.sendMessage(msg).catch(() => {});

// Levels ride their own message: at 10 Hz they must not drag a full status broadcast (and the
// service worker's runtime re-evaluation) along with them.
const meter: MicMeter = new MicMeter({
  getExistingTrack: (): MediaStreamTrack | null => runtime.localAudioTrack(),
  onLevel: (level) => send({ target: "background", type: "offscreen/micLevel", level })
});

const runtime: SipRuntime = new SipRuntime({
  factory: realUaFactory,
  audio,
  micLevel: (): number | null => meter.level(),
  onStatus: (status) => send({ target: "background", type: "offscreen/status", status })
});

// Post-sleep recovery. System sleep cannot be detected from the socket side: FreeSWITCH
// expires the registration while the machine is suspended, but the browser's WebSocket
// looks alive (send() on a half-open TCP connection does not fail), so the runtime would
// keep believing it is registered. Detect the suspension itself instead — a gap in this
// heartbeat far beyond the interval means the page's timers were frozen — and force a
// full transport rebuild + re-registration. The gap threshold stays above Chrome's 60s
// intensive-throttling clamp for hidden pages so throttled beats are not misread as sleep.
const HEARTBEAT_INTERVAL_MS = 10000;
const SUSPEND_GAP_MS = 90000;
let lastBeat = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastBeat > SUSPEND_GAP_MS) {
    runtime.resync();
  } else {
    // FreeSWITCH pings registered contacts with OPTIONS; prolonged silence after pings
    // have been observed means the socket is dead even if no close event ever fired.
    runtime.checkLiveness(now);
  }
  lastBeat = now;
}, HEARTBEAT_INTERVAL_MS);

// Network restored (e.g. Wi-Fi reattaching after wake) — resync immediately rather than
// waiting for the heartbeat to notice.
window.addEventListener("online", () => runtime.resync());

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
    case "runtime/testMic":
      runtime
        .testMic()
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, label: null }));
      return true;
    case "runtime/micMeter":
      meter.setEnabled(raw.on);
      sendResponse(true);
      return false;
  }
  return false;
});
