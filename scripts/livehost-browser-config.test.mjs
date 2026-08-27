import assert from "node:assert/strict";
import test from "node:test";
import { validate_livehost_browser_configuration } from "./livehost-browser-config.mjs";

test("static production requires one secure generic LiveHost origin", () => {
  assert.deepEqual(
    validate_livehost_browser_configuration({ VITE_LIVEHOST_WS_URL: "wss://runtime.example?tenant=public" }),
    { configured: "wss://runtime.example?tenant=public", origin: "wss://runtime.example", localSimulation: false },
  );
  for (const invalid of [
    undefined,
    "",
    "not a URL",
    "https://runtime.example",
    "ws://runtime.example",
    "wss://runtime.example/towl",
  ]) {
    assert.throws(() => validate_livehost_browser_configuration({ VITE_LIVEHOST_WS_URL: invalid }));
  }
});

test("static production permits only the established loopback ws simulation origins", () => {
  for (const value of ["ws://localhost:4191", "ws://127.0.0.1:4191", "ws://[::1]:4191"]) {
    assert.equal(validate_livehost_browser_configuration({ VITE_LIVEHOST_WS_URL: value }).localSimulation, true);
  }
  assert.throws(() => validate_livehost_browser_configuration({ VITE_LIVEHOST_WS_URL: "ws://0.0.0.0:4191" }), /wss:\/\//);
});

test("obsolete application-specific variables do not satisfy production preflight", () => {
  assert.throws(() => validate_livehost_browser_configuration({
    VITE_HOSTED_TEST_WS_URL: "wss://legacy.example",
    VITE_TOWL_WS_URL: "wss://legacy.example",
    VITE_CIRCUIT_VERIFICATION_WS_URL: "wss://legacy.example",
  }), /VITE_LIVEHOST_WS_URL is required/);
});
