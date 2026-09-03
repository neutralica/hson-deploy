# Repository instructions

This repository builds and uploads the static application from the currently
checked-out sources and an already-materialized direct terminal report.

- Tests run in their owning source repositories. Every terminal outcome is
  truthful publishable evidence when its report is structurally valid.
- `npm run build:static` selects `.test-reports/current.json` or an explicit
  `--run <run-id>` and atomically materializes `static-production/`.
- `npm run deploy:static` validates and uploads that existing artifact. The
  `deploy` command is only a direct alias for this upload.
- Deployment must never run tests, select source revisions, or modify Git or
  submodules.
- Never edit `hson-deploy` submodules directly. Make source changes in the
  owning repository and update the gitlink downstream.
