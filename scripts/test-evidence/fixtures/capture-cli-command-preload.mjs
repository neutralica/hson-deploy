import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

if (basename(process.argv[1] ?? "") === "capture-deployment-tests.mts") {
  const candidate = process.env.DEPLOYMENT_CAPTURE_CLI_FIXTURE_CANDIDATE;
  const status = process.env.DEPLOYMENT_CAPTURE_CLI_FIXTURE_STATUS;
  if (candidate === undefined || (status !== "passed" && status !== "failed")) {
    throw new Error("DEPLOYMENT_CAPTURE_CLI_FIXTURE_INVALID");
  }
  globalThis.__deploymentCaptureCliReferencedTimer = setInterval(() => undefined, 60_000);
  globalThis[Symbol.for("terminal-gothic-deploy.capture-command-dependencies")] = Object.freeze({
    async capture() {
      const capture = join(candidate, "capture");
      mkdirSync(capture, { recursive: true });
      writeFileSync(join(capture, "capture-terminal.json"), `${JSON.stringify({ status, lastCheckpoint: "fixture-terminal-persisted" }, null, 2)}\n`);
      if (status === "failed") throw new Error("DEPLOYMENT_CAPTURE_CLI_FIXTURE_FAILURE");
      return candidate;
    },
  });
}
