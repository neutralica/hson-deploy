import { spawnSync } from "node:child_process";

const token = process.env.CLOUDFLARE_API_TOKEN;

if (typeof token === "string" && token.trim() !== "") {
  process.exitCode = 0;
} else {
  const whoami = spawnSync("wrangler", ["whoami"], {
    encoding: "utf8",
    stdio: "ignore",
  });

  if (whoami.status !== 0) {
    console.error(
      "Cloudflare deployment authentication is unavailable. Set CLOUDFLARE_API_TOKEN for CI, or run `wrangler login` locally and retry."
    );
    process.exitCode = 1;
  }
}
