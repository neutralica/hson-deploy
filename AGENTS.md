# Repository instructions

This repository builds and uploads the static application from the currently
checked-out sources and an already-materialized direct terminal report.

- Tests run in their owning source repositories. Every terminal outcome is
  truthful publishable evidence when its report is structurally valid.
- `npm run build:static` selects `.test-reports/current.json` or an explicit
  `--run <run-id>` and atomically materializes `static-production/`.
- `npm run deploy:static` validates and uploads that existing artifact without
  rebuilding it. `npm run deploy:worker` prepares and deploys only the TOWL
  Worker. `npm run deploy` builds static once, preflights both production
  targets, deploys the Worker, and then uploads the exact static artifact.
- Deployment-facing build and upload commands share the checkout-local
  `.deployment-lock/` and fail immediately when another operation owns it.
- Deployment must never run tests, select source revisions, or modify Git or
  submodules. Deployment certification and deployment packaging do not exist.
- `npm run subs:update` is the explicit, lock-aware repository-maintenance
  command that synchronizes the two source gitlinks to clean owning sibling
  HEADs without committing. `npm run deploy:latest` is the distinct convenience
  workflow that synchronizes, creates a gitlink-only local commit when needed,
  and then executes the normal deployment under one outer lock. Neither pushes.
- Plain `npm run deploy` remains source-immutable and redeploys exactly the
  revisions already pinned by the deployment checkout.
- The production TOWL Worker origin defaults from the tracked deployment target;
  an explicit `HSON_TOWL_WORKER_WS_ORIGIN` may override it subject to the same
  target-agreement guards.
- Never edit `hson-deploy` submodules directly. Make source changes in the
  owning repository and update the gitlink downstream.
