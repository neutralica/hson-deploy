import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verify_cloudflare_authentication(options = {}) {
  const environment = options.environment ?? process.env;
  const run = options.run ?? ((command, arguments_) => spawnSync(command, arguments_, { encoding: "utf8", stdio: "ignore", env: environment }));
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (typeof token === "string" && token.trim() !== "") return Object.freeze({ method: "token" });
  const result = run("wrangler", ["whoami", "--json"]);
  if (result.status !== 0) throw new Error("Cloudflare deployment authentication is unavailable. Set CLOUDFLARE_API_TOKEN for CI, or run `wrangler login` locally and retry.");
  return Object.freeze({ method: "wrangler-login" });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { verify_cloudflare_authentication(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
