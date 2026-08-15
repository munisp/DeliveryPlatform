const fs = require("node:fs");
const path = require("node:path");

const auditPath = process.argv[2];
if (!auditPath) {
  throw new Error("Pass the pnpm audit JSON file as the first argument");
}

const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
const permittedImageSizeAdvisories = new Set(["1138808", "1138809"]);
const highOrCritical = Object.entries(audit.advisories ?? {}).filter(([, advisory]) =>
  ["high", "critical"].includes(advisory.severity),
);
const unexpected = highOrCritical.filter(([id]) => !permittedImageSizeAdvisories.has(id));

if (unexpected.length > 0) {
  const summary = unexpected
    .map(([id, advisory]) => `${id}:${advisory.module_name}:${advisory.severity}`)
    .join(", ");
  throw new Error(`Blocking production dependency advisories: ${summary}`);
}

for (const [id, advisory] of highOrCritical) {
  if (advisory.module_name !== "image-size") {
    throw new Error(`Permitted advisory ${id} does not resolve to image-size`);
  }
  for (const finding of advisory.findings ?? []) {
    if (finding.version !== "1.2.1") {
      throw new Error(`Permitted advisory ${id} resolved unexpected image-size version ${finding.version}`);
    }
    if (!(finding.paths ?? []).every((entry) => entry.endsWith(">metro>image-size"))) {
      throw new Error(`Permitted advisory ${id} escaped the expected Expo Metro path`);
    }
  }
}

const lockfile = fs.readFileSync(path.resolve(__dirname, "..", "pnpm-lock.yaml"), "utf8");
if (!lockfile.includes("image-size@1.2.1:") || !lockfile.includes("patches/image-size@1.2.1.patch")) {
  throw new Error("The approved image-size@1.2.1 pnpm patch is not recorded in the lockfile");
}

console.log(
  `PASS: production audit contains ${highOrCritical.length} source-verified image-size residual advisory/advisories and no other High or Critical finding`,
);
