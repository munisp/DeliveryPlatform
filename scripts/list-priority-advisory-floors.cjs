const fs = require("node:fs");

const audit = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const seen = new Set();

for (const advisory of Object.values(audit.advisories || {})) {
  if (!["critical", "high"].includes(advisory.severity)) continue;
  const key = `${advisory.module_name}\t${advisory.patched_versions}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log([advisory.severity, advisory.module_name, advisory.patched_versions, advisory.title].join("\t"));
}
