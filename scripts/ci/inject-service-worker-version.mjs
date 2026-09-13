#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const [serviceWorkerArg, entryHtmlArg] = process.argv.slice(2);
const targets = [
  {
    path: resolve(serviceWorkerArg ?? "dist/sw.js"),
    token: "__SW_BUILD_VERSION__",
    label: "service_worker",
  },
  {
    path: resolve(entryHtmlArg ?? "dist/index.html"),
    token: "__APP_BUILD_VERSION_VALUE__",
    label: "html_entry",
  },
];
const version = `${process.env.PWA_BUILD_VERSION ?? process.env.SW_BUILD_VERSION ?? ""}`.trim();

if (!/^[a-zA-Z0-9._-]{7,128}$/.test(version)) {
  throw new Error(
    "PWA_BUILD_VERSION or SW_BUILD_VERSION must be an immutable release identifier of 7-128 alphanumeric, dot, underscore, or hyphen characters",
  );
}

const replacements = await Promise.all(
  targets.map(async ({ path, token, label }) => {
    const source = await readFile(path, "utf8");
    const occurrences = source.split(token).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `expected exactly one ${token} token in ${path}; found ${occurrences}`,
      );
    }

    const rendered = source.replace(token, version);
    if (rendered.includes(token) || rendered.includes('"dev"')) {
      throw new Error(`${label} version injection left an unsafe placeholder`);
    }

    return { path, rendered, label };
  }),
);

await Promise.all(
  replacements.map(async ({ path, rendered }) => {
    const temporaryTarget = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryTarget, rendered, "utf8");
    await rename(temporaryTarget, path);
  }),
);

console.log(
  `pwa_build_version_injected=${version} targets=${replacements.map(({ label }) => label).join(",")}`,
);
