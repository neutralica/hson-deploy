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
- Never edit `hson-deploy` submodules directly. Make source changes in the
  owning repository and update the gitlink downstream.
