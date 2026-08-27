import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { validate_accepted_static_test_evidence } from "./static-test-evidence-config.mjs";

function parse_json(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (cause) { throw new Error(`${label} is not valid JSON.`, { cause }); }
}

function public_index(source) {
  return source;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function safe_relative_path(value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Public frozen evidence path is unsafe: ${String(value)}.`);
  }
  return value;
}

async function referenced_json(evidenceRoot, reference, expectedPrefix) {
  const path = safe_relative_path(reference?.path);
  if (!new RegExp(`^${expectedPrefix}/[A-Za-z0-9_-]+\\.json$`).test(path)) throw new Error(`Public frozen evidence has an invalid ${expectedPrefix} path: ${path}.`);
  const bytes = await readFile(resolve(evidenceRoot, path));
  if (bytes.byteLength !== reference.rawBytes || sha256(bytes) !== reference.sha256) throw new Error(`Accepted frozen evidence metadata mismatch before static assembly: ${path}.`);
  return { path, reference, value: parse_json(bytes, `Accepted frozen evidence ${path}`) };
}

async function public_references(index, evidenceRoot) {
  const output = [];
  const suiteIds = new Set();
  const caseIds = new Set();
  for (const category of index.categories ?? []) {
    const categoryRecord = await referenced_json(evidenceRoot, category.listing, "categories");
    if (categoryRecord.value.categoryId !== category.id) throw new Error(`Accepted frozen category identity mismatch: ${category.id}.`);
    output.push(categoryRecord);
    for (const suite of categoryRecord.value.suites ?? []) {
      if (suite.categoryId !== category.id || suiteIds.has(suite.id)) throw new Error(`Accepted frozen suite category or identity mismatch: ${suite.id}.`);
      suiteIds.add(suite.id);
      const suiteRecord = await referenced_json(evidenceRoot, suite.listing, "suites");
      if (suiteRecord.value.categoryId !== category.id || suiteRecord.value.suiteId !== suite.id) throw new Error(`Accepted frozen suite envelope identity mismatch: ${suite.id}.`);
      output.push(suiteRecord);
      for (const item of suiteRecord.value.cases ?? []) {
        if (caseIds.has(item.id)) throw new Error(`Accepted frozen case identity is duplicated: ${item.id}.`);
        caseIds.add(item.id);
        if (item.evidence?.available !== true) continue;
        const caseRecord = await referenced_json(evidenceRoot, item.evidence, "cases");
        if (caseRecord.value.suiteId !== suite.id || caseRecord.value.caseId !== item.id) throw new Error(`Accepted frozen case envelope identity mismatch: ${item.id}.`);
        output.push(caseRecord);
      }
    }
  }
  return output;
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
  const references = await public_references(index, accepted.evidenceRoot);
  const unique = new Map(references.map((record) => [record.path, record.reference]));
  await mkdir(destination, { recursive: true });
  const projectedIndexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  await writeFile(resolve(destination, "index.json"), projectedIndexBytes);

  let caseBytes = 0;
  let suiteBytes = 0;
  let categoryBytes = 0;
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
    else if (path.startsWith("categories/")) categoryBytes += sourceStats.size;
    else throw new Error(`Public frozen evidence row has an unsupported path: ${path}.`);
  }
  return Object.freeze({
    evidenceRoot: accepted.root,
    destination,
    fileCount: unique.size + 1,
    indexBytes: projectedIndexBytes.byteLength,
    caseBytes,
    suiteBytes,
    categoryBytes,
    provenanceBytes: 0,
    rawBytes: projectedIndexBytes.byteLength + categoryBytes + caseBytes + suiteBytes,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const result = await assemble_static_test_evidence();
  console.log(`Static frozen evidence assembled at ${result.destination}: ${result.fileCount} files, ${result.rawBytes} raw bytes.`);
}
