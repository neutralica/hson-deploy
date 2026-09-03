import { verify_static_production_artifact } from "./verify-static-production-artifact.mjs";

const result = await verify_static_production_artifact({ requireSecurePublic: process.argv.includes("--public") });
console.log(`Static production preflight: immutable report ${result.evidenceRoot} (${result.reportStatus}) and frozen visitor boundary verified.`);
