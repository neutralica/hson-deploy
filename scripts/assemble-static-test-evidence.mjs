import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validate_accepted_static_test_evidence } from "./static-test-evidence-config.mjs";

function parse_json(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (cause) { throw new Error(`${label} is not valid JSON.`, { cause }); }
}

function public_index(source) {
  return {
    ...source,
    categories: source.categories.map(({ report: _report, ...category }) => category),
  };
}

function row_references(index) {
  const references = [];
  for (const suite of index.suites) {
    if (suite.evidence?.available === true) references.push(suite.evidence);
    for (const item of suite.cases) if (item.evidence?.available === true) references.push(item.evidence);
  }
  return references;
}

function safe_relative_path(value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Public frozen evidence path is unsafe: ${String(value)}.`);
  }
  return value;
}

export async function assemble_static_test_evidence(options = {}) {
  const environment = options.environment ?? process.env;
  const accepted = validate_accepted_static_test_evidence(environment);
  const artifact = resolve(options.artifact ?? resolve(import.meta.dirname, "..", "static-production"));
  const destination = resolve(artifact, accepted.root.slice(1));
  if (!existsSync(resolve(artifact, "index.html"))) throw new Error("Static production artifact is missing index.html before frozen evidence assembly.");
  if (existsSync(destination)) throw new Error(`Static production artifact already contains frozen evidence at ${destination}.`);

  const indexBytes = await readFile(accepted.indexPath);
  const index = public_index(parse_json(indexBytes, "Accepted Phase 3 index"));
  if (JSON.stringify(index).includes("reports/")) throw new Error("Public frozen index must not retain canonical report paths.");
  const references = row_references(index);
  const unique = new Map(references.map((reference) => [safe_relative_path(reference.path), reference]));
  await mkdir(destination, { recursive: true });
  const projectedIndexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  await writeFile(resolve(destination, "index.json"), projectedIndexBytes);

  let caseBytes = 0;
  let suiteBytes = 0;
  for (const [path, reference] of unique) {
    const source = resolve(accepted.evidenceRoot, path);
    const target = resolve(destination, path);
    if (!target.startsWith(`${destination}/`)) throw new Error(`Public frozen evidence path escapes static artifact: ${path}.`);
    const sourceStats = await stat(source);
    if (sourceStats.size !== reference.rawBytes) throw new Error(`Accepted frozen evidence byte mismatch before static assembly: ${path}.`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    if (path.startsWith("cases/")) caseBytes += sourceStats.size;
    else if (path.startsWith("suites/")) suiteBytes += sourceStats.size;
    else throw new Error(`Public frozen evidence row has an unsupported path: ${path}.`);
  }
  return Object.freeze({
    evidenceRoot: accepted.root,
    destination,
    fileCount: unique.size + 1,
    indexBytes: projectedIndexBytes.byteLength,
    caseBytes,
    suiteBytes,
    provenanceBytes: 0,
    rawBytes: projectedIndexBytes.byteLength + caseBytes + suiteBytes,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const result = await assemble_static_test_evidence();
  console.log(`Static frozen evidence assembled at ${result.destination}: ${result.fileCount} files, ${result.rawBytes} raw bytes.`);
}
