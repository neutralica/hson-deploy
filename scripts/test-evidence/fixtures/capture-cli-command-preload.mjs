import { appendFileSync } from "node:fs";
import { basename } from "node:path";

if (basename(process.argv[1] ?? "") === "capture-deployment-tests.mts") {
  globalThis.__deploymentCaptureCliReferencedTimer = setInterval(() => undefined, 60_000);
  if (process.env.DEPLOYMENT_CAPTURE_CLI_PREFLIGHT_TIMER_ONLY === "1") {
    // The real capture implementation remains installed for the preflight boundary regression.
  } else if (process.env.DEPLOYMENT_CAPTURE_CLI_REAL_VALIDATION_FAILURE === "1") {
    const trace = process.env.DEPLOYMENT_CAPTURE_CLI_FIXTURE_TRACE;
    if (trace === undefined) throw new Error("DEPLOYMENT_CAPTURE_CLI_REAL_VALIDATION_TRACE_MISSING");
    globalThis[Symbol.for("terminal-gothic-deploy.capture-command-dependencies")] = Object.freeze({
      checkpoint: (entry) => { appendFileSync(trace, `${JSON.stringify(entry)}\n`); },
      captureOptions: Object.freeze({
        selectionOverrides: Object.freeze({
          certification: Object.freeze(["verification/demo/test-node-process-supervisor"]),
        }),
        validationExpectedSelectionOverrides: Object.freeze({
          certification: Object.freeze(["verification/demo/test-presentation-cleanup-node"]),
        }),
      }),
    });
  }
}
