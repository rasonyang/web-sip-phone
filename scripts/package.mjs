import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const out = `web-sip-phone-${version}.zip`;
execFileSync("zip", ["-r", `../${out}`, "."], { cwd: "dist", stdio: "inherit" });
console.log(`Wrote ${out}`);
