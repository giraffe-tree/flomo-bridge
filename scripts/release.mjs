#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "manifest.json");

if (!existsSync(manifestPath)) {
  console.error("Error: manifest.json not found.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const tag = manifest.version;

console.log("Building plugin...");
const buildResult = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (buildResult.error) {
  console.error("Failed to run `npm run build`. Is npm installed?");
  process.exit(1);
}
if (buildResult.status !== 0) {
  console.error(`Build failed with exit code: ${buildResult.status}`);
  process.exit(buildResult.status ?? 1);
}

const requiredFiles = ["main.js", "manifest.json", "styles.css"];
const missing = requiredFiles.filter((f) => !existsSync(path.join(root, f)));
if (missing.length > 0) {
  console.error(`Error: missing required files: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Creating GitHub Release for version ${tag}...`);

const result = spawnSync(
  "gh",
  [
    "release",
    "create",
    tag,
    "main.js",
    "manifest.json",
    "styles.css",
    "--title",
    `${manifest.name} ${tag}`,
    "--notes",
    `Release ${tag} for Obsidian community plugin market.`,
  ],
  { cwd: root, stdio: "inherit" }
);

if (result.error) {
  console.error("Failed to run \`gh release create\`. Is the GitHub CLI installed and authenticated?");
  process.exit(1);
}

process.exit(result.status ?? 0);
