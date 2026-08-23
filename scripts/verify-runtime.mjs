const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || major >= 25 || (major === 22 && minor < 12)) {
  console.error(`Unsupported Node.js ${process.versions.node}; require >=22.12.0 <25.`);
  process.exit(1);
}

const userAgent = process.env.npm_config_user_agent ?? "";
const npmMatch = /npm\/(\d+)/.exec(userAgent);
if (npmMatch === null || Number(npmMatch[1]) < 10 || Number(npmMatch[1]) >= 12) {
  console.error("Unsupported npm; require >=10 <12.");
  process.exit(1);
}

console.log(`runtime verification: Node.js ${process.versions.node}, npm ${npmMatch[1]}`);
