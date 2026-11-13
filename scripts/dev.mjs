import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(projectRoot, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const node = process.execPath;
const children = [
  spawn(node, [path.join(projectRoot, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", ...process.argv.slice(2)], { cwd: projectRoot, stdio: "inherit", env: process.env }),
  spawn(node, [path.join(projectRoot, "node_modules/tsx/dist/cli.mjs"), "src/worker.ts"], { cwd: projectRoot, stdio: "inherit", env: process.env }),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}
for (const child of children) {
  child.on("error", error => { console.error(error.message); close(1); });
  child.on("exit", code => { if (!closing) close(code ?? 1); });
}
process.on("SIGINT", () => close());
process.on("SIGTERM", () => close());
