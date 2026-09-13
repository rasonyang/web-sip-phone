import { mountWebSipPhone } from "./instance.js";

// Top-level pages only; dynamic registration and scripting.executeScript both target the top
// frame already, this is defense in depth. A second copy of this script (an injection into a tab
// that already has one, or one left orphaned by an extension reload) is replaced, not skipped.
if (window.top === window) {
  mountWebSipPhone();
}
