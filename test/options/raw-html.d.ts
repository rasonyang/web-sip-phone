/**
 * Vite's `?raw` suffix, used so the options test renders the real static/options.html without
 * pulling Node's `fs` types into a tsconfig that only carries the Chrome ones.
 */
declare module "*.html?raw" {
  const content: string;
  export default content;
}
