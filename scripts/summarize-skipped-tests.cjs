#!/usr/bin/env node
const fs = require("fs");

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/summarize-skipped-tests.cjs <vitest-report.json>");
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(input, "utf8"));
const skipped = [];
for (const suite of report.testResults || []) {
  for (const assertion of suite.assertionResults || []) {
    if (assertion.status === "skipped") {
      skipped.push({
        file: suite.name?.replace(process.cwd() + "/", "") || "unknown",
        suite: (assertion.ancestorTitles || []).join(" > "),
        title: assertion.title,
      });
    }
  }
}

const grouped = new Map();
for (const item of skipped) {
  const key = `${item.file} :: ${item.suite}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(item.title);
}

console.log(JSON.stringify({
  totalSkipped: skipped.length,
  groups: [...grouped.entries()].map(([group, titles]) => ({ group, count: titles.length, titles })),
}, null, 2));
