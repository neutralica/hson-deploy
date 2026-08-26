#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULE = "=".repeat(64);
const SUBRULE = "-".repeat(64);
const CAPTURE_COMMAND = /(?:^|[\/\s])capture-deployment-tests\.mts(?:\s|$)/;
const CAPTURE_SUPERVISOR_COMMAND = /(?:^|[\/\s])supervise-certification-capture\.mts(?:\s|$)/;
const CERTIFICATION_ONLY = /(?:^|\s)--certification-only(?:\s|$)/;
const CERTIFIER_COMMAND = /(?:^|[\/\s])certified-package\.mjs\s+certify(?:\s|$)/;
const NPM_CERTIFY_COMMAND = /(?:^|[\/\s])npm(?:\s+[^\s]+)*\s+run\s+certify(?:\s|$)/;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseProcessTable(output) {
  return String(output).split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]), ppid: Number(match[2]), elapsed: match[3],
      cpu: number(match[4]), memory: number(match[5]), stateCode: match[6], command: match[7].trim(),
    }];
  });
}

function processState(code = "") {
  if (code.startsWith("Z")) return "zombie";
  if (code.startsWith("R")) return "running";
  if (code.startsWith("S")) return "sleeping / waiting";
  if (code.startsWith("I")) return "idle";
  if (code.startsWith("T")) return "stopped";
  if (code.startsWith("U") || code.startsWith("D")) return "uninterruptible wait";
  return code || "unknown";
}

function elapsedSeconds(value = "") {
  const match = value.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

function indexProcesses(processes) {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const children = new Map();
  for (const process of processes) {
    const entries = children.get(process.ppid) ?? [];
    entries.push(process);
    children.set(process.ppid, entries);
  }
  return { byPid, children };
}

function ancestors(process, byPid) {
  const result = [];
  const seen = new Set([process.pid]);
  let cursor = process;
  while (byPid.has(cursor.ppid) && !seen.has(cursor.ppid)) {
    cursor = byPid.get(cursor.ppid);
    result.push(cursor);
    seen.add(cursor.pid);
  }
  return result;
}

function descendants(pid, children) {
  const result = [];
  const pending = [...(children.get(pid) ?? [])];
  const seen = new Set([pid]);
  while (pending.length) {
    const process = pending.shift();
    if (seen.has(process.pid)) continue;
    seen.add(process.pid);
    result.push(process);
    pending.push(...(children.get(process.pid) ?? []));
  }
  return result;
}

function isCapture(process) {
  return CAPTURE_SUPERVISOR_COMMAND.test(process.command) || (CAPTURE_COMMAND.test(process.command) && CERTIFICATION_ONLY.test(process.command));
}

function isCertifier(process) {
  return CERTIFIER_COMMAND.test(process.command);
}

function isNpmCertify(process) {
  return NPM_CERTIFY_COMMAND.test(process.command) && !process.command.includes("status:cert");
}

export function discoverCertificationChains(processes) {
  const { byPid, children } = indexProcesses(processes);
  const exactCaptures = processes.filter(isCapture);
  // A shell and its Node child can both expose the same command. Retain the deepest
  // exact capture identity in each ancestry chain, not an arbitrary newest Node PID.
  const captures = exactCaptures.filter((candidate) => !descendants(candidate.pid, children).some(isCapture));
  const principals = captures.length > 0
    ? captures
    : processes.filter((process) => isCertifier(process) && !descendants(process.pid, children).some(isCertifier));
  return principals.map((principal) => {
    const parents = ancestors(principal, byPid);
    const owned = descendants(principal.pid, children);
    return {
      principal,
      capture: isCapture(principal) ? principal : undefined,
      certifier: isCertifier(principal) ? principal : parents.find(isCertifier),
      npm: parents.find(isNpmCertify),
      ancestors: parents,
      descendants: owned,
      directChildren: children.get(principal.pid) ?? [],
    };
  });
}

function readJson(path) {
  if (!existsSync(path)) return { exists: false };
  try { return { exists: true, value: JSON.parse(readFileSync(path, "utf8")) }; }
  catch { return { exists: true, invalid: true }; }
}

export function collectCaptureCandidates(workRoot) {
  try {
    return readdirSync(workRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("capture-")).map((entry) => {
      const path = join(workRoot, entry.name);
      const capture = join(path, "capture");
      const stats = statSync(path);
      return {
        name: entry.name, path, createdMs: stats.birthtimeMs || stats.ctimeMs,
        metadata: readJson(join(capture, "capture-metadata.json")),
        certification: readJson(join(capture, "certification.json")),
        cleanup: readJson(join(capture, "capture-cleanup.json")),
        terminal: readJson(join(capture, "capture-terminal.json")),
      };
    }).sort((a, b) => b.createdMs - a.createdMs);
  } catch {
    return [];
  }
}

function candidateFor(chain, candidates, nowMs) {
  const seconds = elapsedSeconds(chain.principal.elapsed);
  if (seconds === undefined) return candidates[0];
  const startedMs = nowMs - seconds * 1000;
  return candidates.filter((candidate) => candidate.createdMs >= startedMs - 30_000 && candidate.createdMs <= nowMs + 2_000)[0];
}

function semanticCommand(command) {
  const npm = command.match(/(?:^|\s)npm(?:\s+-w\s+\S+)?\s+run\s+([^\s]+)/);
  if (npm) return npm[1];
  if (/playwright(?:\/|\s|$)/.test(command)) return "playwright";
  if (/(?:hosted-test-server|hosted-test-server\.mjs)/.test(command)) return "hosted-test-server";
  if (/(?:^|[\/\s])vite(?:\s|$)/.test(command)) return "vite";
  return undefined;
}

function workspace(command) {
  return command.match(/(?:^|[\/\s])(run-[A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
}

function currentWork(descendantProcesses) {
  const seen = new Set();
  return descendantProcesses.flatMap((process) => {
    const name = semanticCommand(process.command);
    if (!name) return [];
    const key = `${name}:${workspace(process.command) ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name, pid: process.pid, elapsed: process.elapsed, state: processState(process.stateCode), workspace: workspace(process.command) }];
  });
}

function terminalState(record) {
  if (!record?.exists) return "not created";
  if (record.invalid) return "present (unreadable)";
  const status = String(record.value?.status ?? "").toLowerCase();
  if (status === "passed" || status === "pass") return "terminal PASS";
  if (status === "failed" || status === "fail") return "terminal FAIL";
  return "present";
}

function recordState(record, pendingWhenMissing = false) {
  if (!record?.exists) return pendingWhenMissing ? "pending" : "not created";
  return record.invalid ? "present (unreadable)" : "present";
}

function assess(chain, sockets, candidate, socketsAvailable) {
  const directZombies = chain.directChildren.filter((process) => process.stateCode?.startsWith("Z")).length;
  const owned = [chain.principal, ...chain.descendants];
  const liveDescendants = chain.descendants.filter((process) => !process.stateCode?.startsWith("Z"));
  const cpu = owned.reduce((sum, process) => sum + (process.cpu ?? 0), 0);
  const terminal = candidate?.terminal?.exists;
  if (terminal) {
    const cleanupSettled = candidate?.cleanup?.exists;
    return {
      category: "TERMINAL BUT PROCESS STILL ALIVE",
      explanation: cleanupSettled
        ? "Certification has durably completed and cleanup is settled, but the capture CLI has not exited."
        : "Certification has a durable terminal record, but the capture CLI has not exited; cleanup state is not yet present.",
    };
  }
  if (directZombies > 0) return { category: "ZOMBIE CHILD DETECTED", explanation: "An owned direct child is a zombie. No process was terminated." };
  if (cpu >= 0.1 || liveDescendants.length > 0 || (socketsAvailable && sockets.length > 0)) return { category: "ACTIVE", explanation: "Certification is doing observable work." };
  if (!socketsAvailable) return { category: "UNKNOWN — INCOMPLETE INSPECTION", explanation: "The certification is alive, but socket inspection was unavailable. No conclusion was inferred from missing data." };
  return { category: "SUSPICIOUS / QUIESCENT", explanation: "The certification capture is still alive, but no CPU activity, child work, or sockets are observable. This does not automatically prove a hang." };
}

export function analyzeCertification({ processes, sockets = [], captureCandidates = [], nowMs = Date.now(), processInspectionAvailable = true, socketsAvailable = true }) {
  if (!processInspectionAvailable) return { status: "UNKNOWN — PROCESS INSPECTION UNAVAILABLE", chains: [], historicalUnownedH2: undefined };
  const chains = discoverCertificationChains(processes);
  const ownedPids = new Set(chains.flatMap((chain) => [chain.principal.pid, ...chain.descendants.map(({ pid }) => pid), ...chain.ancestors.map(({ pid }) => pid)]));
  const historicalUnownedH2 = processes.filter((process) => /(?:^|[\/\s])run-[A-Za-z0-9._-]+/.test(process.command) && /hson-h2/.test(process.command) && !ownedPids.has(process.pid)).length;
  if (chains.length === 0) return { status: "NOT RUNNING", chains: [], historicalUnownedH2 };
  if (chains.length > 1) {
    const details = chains.map((chain) => {
      const owned = new Set([chain.principal.pid, ...chain.descendants.map(({ pid }) => pid)]);
      return { chain, candidate: candidateFor(chain, captureCandidates, nowMs), sockets: sockets.filter((socket) => owned.has(socket.pid)) };
    });
    return { status: "AMBIGUOUS — MULTIPLE CAPTURES", chains, details, historicalUnownedH2 };
  }
  const chain = chains[0];
  const candidate = candidateFor(chain, captureCandidates, nowMs);
  const owned = new Set([chain.principal.pid, ...chain.descendants.map(({ pid }) => pid)]);
  const ownedSockets = sockets.filter((socket) => owned.has(socket.pid));
  const assessment = assess(chain, ownedSockets, candidate, socketsAvailable);
  return { status: assessment.category, chains, chain, candidate, sockets: ownedSockets, socketsAvailable, work: currentWork(chain.descendants), assessment, historicalUnownedH2 };
}

function label(name, value, indent = " ") {
  const dots = ".".repeat(Math.max(2, 20 - name.length));
  return `${indent}${name} ${dots} ${value ?? "unknown"}`;
}

function section(name) {
  return `\n${SUBRULE}\n ${name}\n${SUBRULE}\n`;
}

function captureLines(candidate) {
  if (!candidate) return [label("Latest candidate", "not found"), label("capture-metadata.json", "not created"), label("Terminal record", "not created"), label("Cleanup record", "pending"), label("Certification JSON", "pending")];
  return [
    label("Latest candidate", candidate.name),
    label("capture-metadata.json", recordState(candidate.metadata)),
    label("Terminal record", terminalState(candidate.terminal)),
    label("Cleanup record", recordState(candidate.cleanup, true)),
    label("Certification JSON", recordState(candidate.certification, true)),
  ];
}

function socketSummary(sockets) {
  const listening = sockets.filter((socket) => socket.state === "LISTEN");
  const established = sockets.filter((socket) => socket.state === "ESTABLISHED");
  return { listening, established };
}

export function renderCertificationStatus(result) {
  const lines = [RULE, " CERTIFICATION STATUS", RULE, "", "Overall", label("Status", result.status)];
  if (result.status === "UNKNOWN — PROCESS INSPECTION UNAVAILABLE") {
    lines.push(section("ASSESSMENT"), " UNKNOWN", "", " The operating-system process table could not be inspected.", " No running/not-running conclusion was inferred.", "", RULE);
    return lines.join("\n");
  }
  if (result.status === "NOT RUNNING") {
    if (result.historicalUnownedH2) lines.push(label("Historical/unowned H2 processes", result.historicalUnownedH2));
    lines.push(section("ASSESSMENT"), " NOT RUNNING", "", " No active certification process chain was found.", "", RULE);
    return lines.join("\n");
  }
  if (result.status === "AMBIGUOUS — MULTIPLE CAPTURES") {
    lines.push("", ` ${result.chains.length} plausible independent certification captures were found:`, "");
    for (const detail of result.details) {
      const { chain } = detail;
      const directLive = chain.directChildren.filter((process) => !process.stateCode?.startsWith("Z")).length;
      lines.push(
        label("Capture PID", chain.capture?.pid ?? chain.principal.pid),
        label("Elapsed", chain.principal.elapsed),
        label("CPU", chain.principal.cpu === undefined ? "unknown" : `${chain.principal.cpu.toFixed(1)}%`),
        label("Memory", chain.principal.memory === undefined ? "unknown" : `${chain.principal.memory.toFixed(1)}%`),
        label("Process state", processState(chain.principal.stateCode)),
        label("Live children", directLive),
        label("Zombie children", chain.directChildren.length - directLive),
        label("Open sockets", detail.sockets.length),
        label("Latest candidate", detail.candidate?.name ?? "not found"),
        "",
      );
    }
    lines.push(section("ASSESSMENT"), " AMBIGUOUS — MULTIPLE CAPTURES", "", " No single certification was selected. Process ancestry shows multiple independent candidates.", "", RULE);
    return lines.join("\n");
  }
  const { chain } = result;
  const capture = chain.capture ?? chain.principal;
  lines.push(label("Capture PID", capture.pid), label("Elapsed", capture.elapsed), label("CPU", capture.cpu === undefined ? "unknown" : `${capture.cpu.toFixed(1)}%`), label("Memory", capture.memory === undefined ? "unknown" : `${capture.memory.toFixed(1)}%`), label("Process state", processState(capture.stateCode)));
  if (result.work.length) {
    lines.push(section("CURRENT WORK"));
    for (const work of result.work) {
      lines.push(` ${work.name}`, label("PID", work.pid, "   "), label("Elapsed", work.elapsed, "   "), label("State", work.state, "   "));
      if (work.workspace) lines.push(label("Workspace", work.workspace, "   "));
      lines.push("");
    }
  }
  const directLive = chain.directChildren.filter((process) => !process.stateCode?.startsWith("Z")).length;
  const directZombies = chain.directChildren.length - directLive;
  const network = socketSummary(result.sockets);
  lines.push(section("PROCESS OWNERSHIP"), label("Live children", directLive), label("Zombie children", directZombies), label("Live descendants", chain.descendants.filter((process) => !process.stateCode?.startsWith("Z")).length), label("Open sockets", result.socketsAvailable ? result.sockets.length : "unknown"));
  if (network.listening.length) lines.push("", " Network", ...network.listening.map((socket) => label("LISTEN", socket.name ?? "unknown", "   ")));
  lines.push(label("ESTABLISHED", network.established.length, network.listening.length ? "   " : " "));
  if (result.historicalUnownedH2) lines.push("", label("Historical/unowned H2 processes", result.historicalUnownedH2));
  lines.push(section("CAPTURE STATE"), ...captureLines(result.candidate));
  lines.push(section("ASSESSMENT"), ` ${result.assessment.category}`);
  if (result.assessment.category !== "ACTIVE") lines.push("", ` ${result.assessment.explanation}`);
  if (result.assessment.category === "SUSPICIOUS / QUIESCENT") lines.push(" Inspect retained capture state before deciding whether to terminate the run.");
  lines.push("", RULE);
  return lines.join("\n");
}

function collectProcesses() {
  try {
    return parseProcessTable(execFileSync("ps", ["-axo", "pid=,ppid=,etime=,%cpu=,%mem=,state=,command="], { encoding: "utf8" }));
  } catch {
    return undefined;
  }
}

export function parseLsof(output) {
  return String(output).split(/\r?\n/).slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) return [];
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid)) return [];
    const name = fields.slice(8).join(" ").replace(/\s+\((LISTEN|ESTABLISHED)\)$/, "");
    const state = line.match(/\((LISTEN|ESTABLISHED)\)\s*$/)?.[1] ?? "OTHER";
    return [{ pid, state, name }];
  });
}

function collectSockets() {
  try { return parseLsof(execFileSync("lsof", ["-nP", "-i"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return undefined; }
}

export function main() {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const processes = collectProcesses();
  const sockets = collectSockets();
  const result = analyzeCertification({
    processes: processes ?? [], processInspectionAvailable: processes !== undefined,
    sockets: sockets ?? [], socketsAvailable: sockets !== undefined,
    captureCandidates: collectCaptureCandidates(join(repositoryRoot, ".deployment-work")),
  });
  console.log(renderCertificationStatus(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
