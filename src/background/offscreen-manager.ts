export async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
  });
  if (contexts.length > 0) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"] as chrome.offscreen.Reason[],
    justification: "Maintains the SIP over WSS voice connection and plays remote call audio."
  });
}

export async function closeOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
  });
  if (contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}
