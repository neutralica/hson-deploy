import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TERMINAL_STATUSES = new Set(["pass", "fail", "skip", "unsupported", "cancelled", "error"]);
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_PUBLIC_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_PUBLIC_TEXT = /\bBearer\s+(?!<redacted>)[A-Za-z0-9._~+\/-]+=*|\b(token|secret|password|credential)\s*[=:]\s*(?!<redacted>)|\/(?:Users|home)\/[A-Za-z0-9_.-]+/i;

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

export function validate_run_id(value, label = "run ID") {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) throw new Error(`${label} must be a UUID.`);
  return value;
}

export function safe_relative_path(value, prefix) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe static report path: ${String(value)}.`);
  }
  if (prefix !== undefined && !value.startsWith(`${prefix}/`)) throw new Error(`Static report path must be under ${prefix}/: ${value}.`);
  return value;
}

async function regular_file(path, label, maximum = MAX_JSON_BYTES) {
  let state;
  try { state = await lstat(path); }
  catch (cause) { throw new Error(`${label} is missing at ${path}.`, { cause }); }
  if (state.isSymbolicLink() || !state.isFile()) throw new Error(`${label} must be a regular file and may not be a symlink.`);
  if (state.size > maximum) throw new Error(`${label} exceeds the ${maximum}-byte limit.`);
  return state;
}

async function json_file(path, label) {
  await regular_file(path, label);
  const source = await readFile(path, "utf8");
  if (FORBIDDEN_PUBLIC_TEXT.test(source)) throw new Error(`${label} contains non-public data.`);
  try { return object(JSON.parse(source), label); }
  catch (cause) {
    if (cause instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`, { cause });
    throw cause;
  }
}

function require_index_shape(index, runId) {
  if (index.runId !== runId) throw new Error("Static report index runId does not match the selected run.");
  if (!TERMINAL_STATUSES.has(index.status)) throw new Error("Static report index has an invalid terminal status.");
  for (const field of ["categories", "suites", "repositories", "diagnostics", "artifacts"]) {
    if (!Array.isArray(index[field])) throw new Error(`Static report index ${field} must be an array.`);
  }
  object(index.totals, "Static report index totals");
}

export async function validate_progressive_report_site(options) {
  const runId = validate_run_id(options.runId);
  const site = resolve(options.site);
  const siteState = await lstat(site).catch(() => undefined);
  if (siteState === undefined || siteState.isSymbolicLink() || !siteState.isDirectory()) throw new Error(`Static report site is missing or unsafe at ${site}.`);
  const expectedRootEntries = new Set(["index.json", "categories", "suites", "cases", "artifacts"]);
  for (const entry of await readdir(site, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !expectedRootEntries.has(entry.name)) throw new Error(`Static report contains an unexpected root entry: ${entry.name}.`);
  }
  const seen = new Set();
  let publicBytes = 0;

  const load = async (relative, label) => {
    safe_relative_path(relative);
    if (seen.has(relative)) throw new Error(`Static report reference is duplicated: ${relative}.`);
    const path = resolve(site, relative);
    if (!path.startsWith(`${site}/`)) throw new Error(`Static report path escapes its site: ${relative}.`);
    const state = await regular_file(path, label);
    publicBytes += state.size;
    if (publicBytes > MAX_PUBLIC_BYTES) throw new Error("Static report site exceeds the public byte limit.");
    seen.add(relative);
    return json_file(path, label);
  };
  const artifact = async (reference) => {
    const value = object(reference, "Static report artifact reference");
    const relative = safe_relative_path(value.path, "artifacts");
    if (seen.has(relative)) throw new Error(`Static report artifact is referenced more than once: ${relative}.`);
    const path = resolve(site, relative);
    if (!path.startsWith(`${site}/`)) throw new Error(`Static report artifact escapes its site: ${relative}.`);
    const state = await regular_file(path, `Static report artifact ${relative}`, 2 * 1024 * 1024);
    publicBytes += state.size;
    if (publicBytes > MAX_PUBLIC_BYTES) throw new Error("Static report site exceeds the public byte limit.");
    seen.add(relative);
  };

  const index = await load("index.json", "Static report index");
  require_index_shape(index, runId);
  for (const reference of index.artifacts) await artifact(reference);

  const suites = new Map();
  for (const reference of index.suites) {
    const value = object(reference, "Static report suite reference");
    if (typeof value.id !== "string" || value.id.length === 0 || suites.has(value.id)) throw new Error("Static report suite identity is missing or duplicated.");
    suites.set(value.id, safe_relative_path(value.file, "suites"));
  }
  const categories = new Set();
  for (const reference of index.categories) {
    const value = object(reference, "Static report category reference");
    if (typeof value.id !== "string" || value.id.length === 0 || categories.has(value.id) || !TERMINAL_STATUSES.has(value.status)) throw new Error("Static report category reference is malformed or duplicated.");
    categories.add(value.id);
    const category = await load(safe_relative_path(value.file, "categories"), `Static report category ${value.id}`);
    if (category.id !== value.id || !Array.isArray(category.suites)) throw new Error(`Static report category shape is invalid: ${value.id}.`);
    for (const summary of category.suites) {
      const item = object(summary, `Static report category suite ${value.id}`);
      if (typeof item.id !== "string" || item.category !== value.id || !TERMINAL_STATUSES.has(item.status) || suites.get(item.id) !== item.file) {
        throw new Error(`Static report category suite reference is invalid: ${String(item.id)}.`);
      }
    }
  }
  for (const [suiteId, relative] of suites) {
    const suite = await load(relative, `Static report suite ${suiteId}`);
    if (suite.id !== suiteId || !TERMINAL_STATUSES.has(suite.status) || !Array.isArray(suite.cases) || !Array.isArray(suite.diagnostics) || !Array.isArray(suite.artifacts)) {
      throw new Error(`Static report suite shape is invalid: ${suiteId}.`);
    }
    for (const reference of suite.artifacts) await artifact(reference);
    const caseIds = new Set();
    for (const reference of suite.cases) {
      const value = object(reference, `Static report case reference in ${suiteId}`);
      if (typeof value.id !== "string" || value.id.length === 0 || caseIds.has(value.id) || !TERMINAL_STATUSES.has(value.status)) throw new Error(`Static report case reference is invalid in ${suiteId}.`);
      caseIds.add(value.id);
      const record = await load(safe_relative_path(value.file, "cases"), `Static report case ${suiteId}::${value.id}`);
      if (record.id !== value.id || !TERMINAL_STATUSES.has(record.status) || !Array.isArray(record.diagnostics) || !Array.isArray(record.artifacts)) throw new Error(`Static report case shape is invalid: ${suiteId}::${value.id}.`);
      for (const reference of record.artifacts) await artifact(reference);
    }
  }

  for (const folder of ["categories", "suites", "cases", "artifacts"]) {
    const directory = resolve(site, folder);
    const state = await lstat(directory).catch(() => undefined);
    if (state === undefined || state.isSymbolicLink() || !state.isDirectory()) throw new Error(`Static report directory is missing or unsafe: ${folder}/.`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Static report contains an unsafe entry: ${folder}/${entry.name}.`);
      if (!seen.has(`${folder}/${entry.name}`)) throw new Error(`Static report contains an unreferenced public file: ${folder}/${entry.name}.`);
    }
  }
  return Object.freeze({ runId, status: index.status, site, referencedFiles: seen.size, publicBytes });
}

export async function validate_direct_report(options) {
  const runId = validate_run_id(options.runId);
  const runDirectory = resolve(options.runDirectory);
  const runState = await lstat(runDirectory).catch(() => undefined);
  if (runState === undefined || runState.isSymbolicLink() || !runState.isDirectory()) throw new Error(`Direct report directory is missing or unsafe at ${runDirectory}.`);
  const run = await json_file(resolve(runDirectory, "run.json"), "Direct terminal report");
  if (run.id !== runId) throw new Error("Direct terminal report id does not match the selected run.");
  if (!TERMINAL_STATUSES.has(run.status)) throw new Error("Direct terminal report has an invalid terminal status.");
  for (const field of ["repositories", "diagnostics", "artifacts", "suites"]) if (!Array.isArray(run[field])) throw new Error(`Direct terminal report ${field} must be an array.`);
  object(run.selection, "Direct terminal report selection");
  object(run.totals, "Direct terminal report totals");
  const site = await validate_progressive_report_site({ runId, site: resolve(runDirectory, "site") });
  if (site.status !== run.status) throw new Error("Direct terminal report and public site statuses do not match.");
  return Object.freeze({ runId, runDirectory, status: run.status, site: site.site, siteValidation: site });
}
