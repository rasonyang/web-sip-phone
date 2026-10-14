/**
 * How a host page asks for control over the widget's visibility: a static
 * `<meta name="web-sip-phone" content="widget=page">` in its served HTML. "always" is the
 * behaviour of every earlier version and what any page without a usable declaration gets.
 */
export type WidgetMode = "always" | "page";

const META_NAME = "web-sip-phone";

/**
 * Read the declaration. Called once, when the content script mounts: a tag a script adds later
 * must not change what an already-injected instance does, so the behaviour stays predictable.
 *
 * The first `web-sip-phone` meta in document order decides and later ones are ignored, so a
 * page cannot be flipped by markup appended after the real tag. Only the exact value
 * `widget=page` counts; a missing, empty, unknown or over-long `content` is no declaration.
 */
export function readWidgetMode(doc: Document): WidgetMode {
  for (const meta of Array.from(doc.getElementsByTagName("meta"))) {
    if ((meta.getAttribute("name") ?? "").trim().toLowerCase() !== META_NAME) {
      continue;
    }
    const content = (meta.getAttribute("content") ?? "").trim().toLowerCase();
    return /^widget\s*=\s*page$/.test(content) ? "page" : "always";
  }
  return "always";
}
