# Deployment

## Static application and frozen test report

The public static artifact combines the normal production application with one
immutable progressive report produced by `hson-demo2`'s direct reporter:

```text
hson-demo2/.test-reports/<run-id>/{run.json,site/}
        ↓
npm run build:static
        ↓
static-production/test-evidence/<run-id>
        ↓
npm run deploy:static
```

`npm run build:static` uses the report named by `--run <run-id>`, or the report
selected by `.test-reports/current.json` when no run is specified. By default it
looks in the sibling `hson-demo2` checkout first and then this workspace's
`hson-demo2` submodule. Set `HSON_TEST_REPORTS_DIRECTORY` to use another direct
report directory.

Supply the browser-visible production runtime origin while building:

```sh
VITE_LIVEHOST_WS_URL=wss://runtime.example \
npm run build:static -- --run <run-id>
```

The command validates `run.json` and the progressive public site, builds the
application in deploy-owned temporary output, copies exactly that report site
under `/test-evidence/<run-id>`, verifies the frozen visitor boundary, and
atomically replaces `static-production/`. Failed, cancelled, unsupported, and
infrastructure-error reports are valid publication inputs when structurally
safe. Report status and recorded source revisions are descriptive evidence, not
publication gates.

Deploy only after the artifact exists:

```sh
npm run deploy:static
```

This validates the existing artifact, requires its embedded public runtime
origin to use `wss://`, confirms the authenticated account exposes the existing
Cloudflare Pages project `hson-deploy`, and uploads those exact bytes to its
`main` branch. It does not build, run tests, update submodules, or change a
checkout. `npm run deploy` is the direct user-facing alias for this same static
upload behavior. Neither command creates a Pages project or changes custom
domains.

The frozen Tests explorer uses ordinary static HTTP reads. It has no visitor
path for TestRunner, subprocess, Playwright, cancellation, or test discovery.
Product WebSockets remain available for TOWL and circuit behavior through
`VITE_LIVEHOST_WS_URL`; this variable must identify an origin rather than an
application route. Never put bearer tokens or other credentials in a `VITE_*`
variable.

Never edit `hson-deploy` submodules directly. Make source changes in the owning
repository and update the gitlink downstream. Source synchronization is an
explicit repository-maintenance action and is never part of deployment.

## Node production runtime

`npm run prepare:node-production` performs repository-side preparation for the
persistent public Node service:

```text
verify → build Node artifacts → checks → Node production preflight
```

It does not deploy or publish. It requires production
`LOCUS_ALLOWED_ORIGINS` and `LOCUS_BEARER_TOKEN` values. The provider runs
`npm -w hson-demo2 run start:production`; see
[`hson-demo2/DEPLOYMENT.md`](./hson-demo2/DEPLOYMENT.md) for the runtime,
`/healthz`, TLS, WebSocket, and supervision contracts.

## Worker compatibility deployment

`npm run deploy:worker` remains the separate Cloudflare Worker compatibility
deployment for production `/session` and `/towl` behavior. It does not publish
the static application or run hosted tests. Its local preflight retains runtime,
workspace, type, package-resolution, and credential checks relevant to the
Worker deployment.

Use Node `>=22.12.0 <25` and npm `>=10 <12`. Worker deployment requires a
`CLOUDFLARE_API_TOKEN` or an authenticated Wrangler session. Static and Worker
deployment are separate explicit operator actions.
