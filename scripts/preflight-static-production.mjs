const value = process.env.VITE_HOSTED_TEST_WS_URL?.trim();

if (value === undefined || value === "") {
  throw new Error("VITE_HOSTED_TEST_WS_URL is required for static production preparation.");
}

let endpoint;
try {
  endpoint = new URL(value);
} catch {
  throw new Error("VITE_HOSTED_TEST_WS_URL must be a valid WebSocket URL.");
}

if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
  throw new Error("VITE_HOSTED_TEST_WS_URL must use ws:// or wss://.");
}
if (endpoint.hostname === "") {
  throw new Error("VITE_HOSTED_TEST_WS_URL must include a host.");
}
const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
if (endpoint.protocol !== "wss:" && !local) {
  throw new Error("VITE_HOSTED_TEST_WS_URL must use wss:// except for localhost production simulation.");
}

console.log("Static production preflight: frontend WebSocket endpoint configuration verified.");
