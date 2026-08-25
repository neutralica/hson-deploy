import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

if (basename(process.argv[1] ?? "") === "capture-deployment-tests.mts") {
  const candidate = process.env.DEPLOYMENT_CAPTURE_CLI_FIXTURE_CANDIDATE;
  const status = process.env.DEPLOYMENT_CAPTURE_CLI_FIXTURE_STATUS;
  const trace = process.env.DEPLOYMENT_CAPTURE_CLI_FIXTURE_TRACE;
  if (candidate === undefined || trace === undefined || (status !== "passed" && status !== "failed")) {
    throw new Error("DEPLOYMENT_CAPTURE_CLI_FIXTURE_INVALID");
  }
  const checkpoint = (entry) => { appendFileSync(trace, `${JSON.stringify(entry)}\n`); };
  globalThis.__deploymentCaptureCliReferencedTimer = setInterval(() => undefined, 60_000);
  globalThis[Symbol.for("terminal-gothic-deploy.capture-command-dependencies")] = Object.freeze({
    checkpoint,
    async capture() {
      const capture = join(candidate, "capture");
      const terminal = join(capture, "capture-terminal.json");
      await mkdir(capture, { recursive: true });
      const cleanup = join(capture, "capture-cleanup.json");
      const cleanupTemporary = `${cleanup}.tmp`;
      await writeFile(cleanupTemporary, "{}\n", { flag: "wx" });
      JSON.parse(await readFile(cleanupTemporary, "utf8"));
      await rename(cleanupTemporary, cleanup);
      const temporary = join(dirname(terminal), `.${basename(terminal)}.${crypto.randomUUID()}.tmp`);
      const contents = `${JSON.stringify({ status, lastCheckpoint: "fixture-terminal-persisted" }, null, 2)}\n`;
      writeFileSync(temporary, contents, { flag: "wx" });
      JSON.parse(readFileSync(temporary, "utf8"));
      renameSync(temporary, terminal);
      checkpoint({ name: "terminal-file-written", activeResources: process.getActiveResourcesInfo() });
      if (status === "failed") throw new Error("DEPLOYMENT_CAPTURE_CLI_FIXTURE_FAILURE");
      return candidate;
    },
  });
}
