# Hosted authority deployment workflow

## Node hosted authority (default)

The ordinary hosted authority is the persistent Node service, not the Worker.
`npm run prepare:node-production` performs the repository-side preparation
only:

```text
verify → build Node artifacts → checks → Node production preflight
```

It does not deploy, start, publish, update a release pointer, or contact an
external provider. It requires clean gitlink-pinned workspace checkouts and
valid production `LOCUS_ALLOWED_ORIGINS` and `LOCUS_BEARER_TOKEN` values. The
preflight verifies both Node artifacts, sibling `hson-live` resolution (root,
Locus, Locus Node, and Node LiveHost), and required runtime packages.

The eventual provider runs `npm -w hson-demo2 run start:production` from this
prepared workspace. See [`hson-demo2/DEPLOYMENT.md`](./hson-demo2/DEPLOYMENT.md)
for the exact runtime boundary, environment contract, `/healthz` readiness
endpoint, and provider-neutral TLS/WebSocket/process-supervision requirements.

## Static frontend (Node authority)

The ordinary production frontend is a separately published static Vite artifact.
Build it with the public Node WebSocket service origin:

```sh
VITE_HOSTED_TEST_WS_URL=wss://<node-service-host> npm run prepare:static-production
```

This command validates the public client configuration, builds the existing Vite
artifact, and confirms that the configured endpoint is embedded. It does not
deploy or publish the artifact. `VITE_TOWL_WS_URL` and
`VITE_CIRCUIT_VERIFICATION_WS_URL` are optional explicit overrides; when they
are absent, those clients use the hosted endpoint and derive `/towl` and
`/circuit-verification` respectively. Hosted tests derive `/hosted-tests`.

`VITE_*` values are browser-visible. Never place `LOCUS_BEARER_TOKEN`, a bearer
token, or any other credential in a Vite variable. Browser authentication uses
the externally provisioned HttpOnly `locus_auth` cookie (or the configured
`LOCUS_AUTH_COOKIE_NAME`) at the proxy/identity boundary.

## Worker compatibility deployment

`npm run deploy:worker` deploys only the Cloudflare Worker and Durable Object
adapter in `hson-demo2`. It does not publish a static Vite build, deploy the
persistent Node LiveHost service, commit a release, or push Git state.

Before the Worker command can contact Cloudflare, it runs this local sequence:

```text
runtime + clean gitlink verification
→ workspace builds
→ hson-live type/entrypoint and sibling-package-resolution checks + hson-demo2 type checks
→ credential presence check
→ Worker deploy
```

The workspace check requires clean `hson-live` and `hson-demo2` nested
checkouts whose HEAD revisions match the superproject gitlinks. The package
check confirms that `hson-demo2` resolves `hson-live`, `hson-live/locus`, and
`hson-live/locus/node` from the sibling `hson-live` checkout and that their
built artifacts exist.

Use Node `>=22.12.0 <25` and npm `>=10 <12`; the deployment scripts reject
other versions before build or deployment. Worker deployment requires either a
`CLOUDFLARE_API_TOKEN` (for CI) or an authenticated local Wrangler session
(`wrangler login`). Local verification does not read Cloudflare or require
credentials.

`sync:demo2` and `push` remain explicit Git maintenance commands. They are not
part of the Worker deployment command, so no release Git state advances before
the deployment preflight succeeds.
