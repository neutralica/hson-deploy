import { brotliCompressSync, gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { materialize_test_evidence, measure_package } from "./test-evidence/materializer.mjs";

const candidate = process.argv[2];
if (!candidate || process.argv.length !== 3) {
  console.error("usage: npm run materialize:test-evidence -- <capture-candidate>");
  process.exitCode = 2;
} else {
  const result = await materialize_test_evidence(candidate);
  const measurements = await measure_package(result);
  const index = await readFile(join(result.evidenceRoot, "index.json"));
  const semantic = await readFile(join(result.evidenceRoot, "reports/semantic.json"));
  const largestCase = measurements.caseArtifacts.largest;
  const largestCaseBytes = largestCase.path ? await readFile(join(result.evidenceRoot, largestCase.path)) : Buffer.alloc(0);
  console.log(JSON.stringify({
    candidate: result.candidate,
    evidenceRoot: result.evidenceRoot,
    publicRoot: `/${result.publicRoot}`,
    artifactSetSha256: result.provenance.artifactSet.sha256,
    measurements,
    compression: {
      index: { gzipBytes: gzipSync(index).byteLength, brotliBytes: brotliCompressSync(index).byteLength },
      largestCase: { path: largestCase.path, gzipBytes: gzipSync(largestCaseBytes).byteLength, brotliBytes: brotliCompressSync(largestCaseBytes).byteLength },
      semanticReport: { gzipBytes: gzipSync(semantic).byteLength, brotliBytes: brotliCompressSync(semantic).byteLength },
    },
    staticFileObservation: semantic.byteLength > 25_000_000 ? "FULL SEMANTIC REPORT REQUIRES LATER DELIVERY REPRESENTATION DECISION" : null,
  }, null, 2));
}
