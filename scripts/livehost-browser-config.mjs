export function is_local_livehost_websocket_origin(url) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export function validate_livehost_browser_configuration(environment = process.env) {
  const configured = environment.VITE_LIVEHOST_WS_URL?.trim();
  if (configured === undefined || configured === "") {
    throw new Error("VITE_LIVEHOST_WS_URL is required for static production preparation.");
  }

  let endpoint;
  try { endpoint = new URL(configured); }
  catch { throw new Error("VITE_LIVEHOST_WS_URL must be a valid WebSocket URL."); }
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new Error("VITE_LIVEHOST_WS_URL must use ws:// or wss://.");
  }
  if (endpoint.hostname === "") throw new Error("VITE_LIVEHOST_WS_URL must include a host.");
  if (endpoint.pathname !== "/") {
    throw new Error("VITE_LIVEHOST_WS_URL must identify an origin and must not include an application path.");
  }

  const localSimulation = is_local_livehost_websocket_origin(endpoint);
  if (endpoint.protocol !== "wss:" && !localSimulation) {
    throw new Error("VITE_LIVEHOST_WS_URL must use wss:// except for explicit localhost production simulation.");
  }
  return Object.freeze({ configured, origin: endpoint.origin, localSimulation });
}
