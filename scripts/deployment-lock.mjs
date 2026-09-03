import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DEPLOYMENT_LOCK_DIRECTORY = ".deployment-lock";
export const DEPLOYMENT_LOCK_OWNER_FILE = "owner.json";

export async function acquire_deployment_lock(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const lock = resolve(deploymentRoot, DEPLOYMENT_LOCK_DIRECTORY);
  const ownerPath = resolve(lock, DEPLOYMENT_LOCK_OWNER_FILE);
  try { await mkdir(lock); }
  catch (cause) {
    if (cause?.code !== "EEXIST") throw cause;
    const owner = await readFile(ownerPath, "utf8").catch(() => "ownership information is unavailable");
    throw new Error(`Deployment lock is already held at ${lock}. Owner: ${owner.trim()}. If no deployment process is running, manually remove ${lock} and retry.`, { cause });
  }
  const owner = Object.freeze({ pid: process.pid, startedAt: new Date().toISOString(), command: options.command ?? "deployment" });
  try { await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" }); }
  catch (cause) {
    await rm(lock, { recursive: true, force: true });
    throw cause;
  }
  let released = false;
  return Object.freeze({
    path: lock,
    owner,
    async release() {
      if (released) return;
      released = true;
      await rm(lock, { recursive: true, force: true });
    },
  });
}

export async function with_deployment_lock(options, operation) {
  const lock = await acquire_deployment_lock(options);
  try { return await operation(lock); }
  finally { await lock.release(); }
}
