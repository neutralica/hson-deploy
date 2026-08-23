# Worker deployment workflow

`npm run deploy:worker` deploys only the Cloudflare Worker and Durable Object
adapter in `hson-demo2`. It does not publish a static Vite build, deploy the
persistent Node LiveHost service, commit a release, or push Git state.

Before the Worker command can contact Cloudflare, it runs this local sequence:

```text
runtime + clean gitlink verification
→ workspace builds
→ hson-live type/entrypoint and package-surface checks + hson-demo2 type checks
→ credential presence check
→ Worker deploy
```

The workspace check requires clean `hson-live` and `hson-demo2` nested
checkouts whose HEAD revisions match the superproject gitlinks. The package
surface check requires the root, types, LiveTree, LiveMap, Locus (including
Node), and LiveHost (including Node) exports to have built artifacts.

Use Node `>=22.12.0 <25` and npm `>=10 <12`; the deployment scripts reject
other versions before build or deployment. Worker deployment requires either a
`CLOUDFLARE_API_TOKEN` (for CI) or an authenticated local Wrangler session
(`wrangler login`). Local verification does not read Cloudflare or require
credentials.

`sync:demo2` and `push` remain explicit Git maintenance commands. They are not
part of the Worker deployment command, so no release Git state advances before
the deployment preflight succeeds.
