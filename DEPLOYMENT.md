# Hosted authority deployment workflow

## Node hosted authority (default)

The ordinary hosted authority is the persistent public Node service, not the Worker.
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

## Static frontend (frozen public test evidence)

The authoritative public frontend deployment is an explicit Cloudflare Pages
direct upload to the existing `hson-deploy` project. `npm run deploy:static`
verifies the already-assembled `static-production/` artifact, confirms that the
authenticated Cloudflare account exposes exactly that named target, and then
runs the equivalent of:

```sh
wrangler pages deploy static-production --project-name=hson-deploy --branch=main
```

It does not build, test, certify, regenerate evidence, deploy the Worker, create
a Pages project, or change custom domains. The existing Cloudflare Pages Git
integration remains externally enabled and should be disabled before direct
upload becomes the sole production publication authority.

The ordinary operator command is `npm run deploy`. It validates the currently
materialized certified `static-production/` artifact against its own receipt,
evidence identity, accepted materialization, and exact static bytes. If valid,
it deploys those bytes even when their certified deployment commit is older
than the current source checkout. If no valid certified artifact is available,
it runs the existing `certify` command for the currently pinned source,
validates the result, and finally invokes `deploy:static`. It never runs
`subs:update` or workspace verification and does not prepare or mutate source.
The operator supplies the same `VITE_LIVEHOST_WS_URL` used to build the artifact
so reuse verification can prove that exact browser-visible origin is embedded.

`npm run deploy:latest` is the separate source-advancing intention. It runs
`subs:update`, verifies the synchronized workspace, reuses the artifact only
when it is both valid and certified for the resulting deployment commit,
otherwise certifies that commit, and then invokes `deploy:static`.

LiveDemo owns the certified package command and test policy. This repository retains the deployment-workspace
primitives for clean gitlink verification, capture, evidence materialization, static assembly, and artifact
verification. `npm run pack` and `npm run certify` are convenience entrypoints into the single hson-demo2
implementation; they do not contain a second pipeline.

For ordinary local use, both commands require no runtime-origin environment prefix. They use
`ws://127.0.0.1:8787` as the established local production-simulation origin when
`VITE_LIVEHOST_WS_URL` is absent or empty; an explicitly supplied value overrides that default and is
validated before capture begins. Public deployment retains its separate runtime-origin requirements and
is not configured by this local packaging default.

`pack` requires a clean superproject, clean pinned submodules, and (when invoked through a sibling consumer
checkout) the exact same clean hson-demo2 and hson-live revisions as those gitlinks. It rebuilds
`hson-live/dist` before capture, captures only the normal semantic and browser evidence, and then uses the
existing Phase 3 materializer and static assembler/verifier. Its canonical outputs are `.deployment-work/`
for captures and accepted evidence packages and `static-production/` for the verified frozen explorer
artifact.

`certify` first runs the complete integrated hson-demo2 + hson-live authority, then calls the same `pack`
implementation sequentially. On success it adds `static-production/certification-receipt.json`, tied to the
packed deployment commit and evidence artifact-set hash. The receipt is the deliberately small distinction
between a packed explorer and one that passed the declared release authority.

The ordinary production frontend is a separately published static Vite artifact.
Build it from an accepted Phase 3 materialization:

```sh
VITE_TEST_EVIDENCE_ROOT=/test-evidence/<exact-40-hex-hson-deploy-commit> \
TEST_EVIDENCE_ACCEPTANCE_FILE=/absolute/path/to/accepted.json \
VITE_LIVEHOST_WS_URL=wss://<node-livehost-origin> \
npm run prepare:static-production
```

This command validates the accepted immutable evidence root, builds a
deployment-owned Vite artifact in `static-production/`, promotes only the public
index and indexed case/suite row artifacts, and verifies their raw bytes. It does
not deploy or publish the artifact. The public frozen test explorer uses ordinary
HTTP and does not initiate a hosted-test WebSocket or visitor-triggered
execution. Complete semantic, browser, and certification
reports—and `provenance.json`—remain in the accepted build/archive materialization.

`VITE_LIVEHOST_WS_URL` is the browser-visible generic runtime origin. It must
not contain an application path. TOWL derives
`/towl`; circuit verification derives `/circuit-verification`; both first use
the runtime's anonymous `GET /session` admission endpoint. The frozen public
Tests panel never opens a runtime route at visitor runtime. Public production requires `wss://`; explicit
localhost, `127.0.0.1`, and `[::1]` `ws://` values are reserved for local
production simulation.

For the TOWL compatibility lane, set this same variable to the existing
Worker's `wss://` origin. That Worker implements no-cookie `/session` bootstrap
and `/towl` only. It deliberately returns 404 for `/hosted-tests` and
`/circuit-verification`; therefore this lane restores TOWL without restoring
hosted Tests or claiming Circuit support.

`VITE_*` values are browser-visible. Never place `LOCUS_BEARER_TOKEN`, a bearer
token, or any other credential in a Vite variable. The public runtime issues
its HttpOnly `locus_auth` cookie (or configured `LOCUS_AUTH_COOKIE_NAME`) after
an exact-origin anonymous admission request.

## Worker compatibility deployment

`npm run deploy:worker` deploys only the Cloudflare Worker and Durable Object
adapter in `hson-demo2`. It does not publish a static Vite build, deploy the
persistent Node LiveHost service, commit a release, or push Git state.

Restoring public TOWL therefore has two explicit publications: deploy the
existing Worker with `npm run deploy:worker`, then prepare and deploy the static
artifact with that Worker's origin supplied as `VITE_LIVEHOST_WS_URL`. Neither
command creates a Worker project, Durable Object class, Pages project, or paid
service; Wrangler targets the names already encoded in repository config.

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
