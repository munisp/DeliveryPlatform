const fs = require("node:fs");

const auditPath = process.argv[2];
if (!auditPath) {
  throw new Error("Usage: node scripts/summarize-production-audit.cjs <audit-json-path>");
}

const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
const advisories = Object.values(audit.advisories || {});
const findings = advisories
  .filter((advisory) => ["critical", "high"].includes(advisory.severity))
  .map((advisory) => ({
    severity: advisory.severity,
    package: advisory.module_name,
    title: advisory.title,
    patched: advisory.patched_versions,
    findings: advisory.findings?.length || 0,
    paths: (advisory.findings || []).slice(0, 3).map((finding) => finding.paths?.[0]).filter(Boolean),
  }))
  .sort((left, right) => {
    const severity = { critical: 0, high: 1 };
    return severity[left.severity] - severity[right.severity] || right.findings - left.findings;
  });

const summary = findings.reduce((accumulator, finding) => {
  accumulator[finding.severity] = (accumulator[finding.severity] || 0) + 1;
  return accumulator;
}, {});

console.log(JSON.stringify({ summary, findings }, null, 2));
