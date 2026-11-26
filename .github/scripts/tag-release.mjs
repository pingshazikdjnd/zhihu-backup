import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function readRootVersion() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if (!pkg.version || typeof pkg.version !== "string") {
    throw new Error("Root package.json is missing a valid version field");
  }
  return pkg.version.trim();
}

function readParentVersion() {
  const res = spawnSync("git", ["show", "HEAD^1:package.json"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    return null;
  }
  try {
    const pkg = JSON.parse(res.stdout);
    return typeof pkg.version === "string" ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function hasParentAdoptedChangesets() {
  const res = spawnSync(
    "git",
    ["cat-file", "-e", "HEAD^1:.changeset/config.json"],
    { stdio: "ignore" },
  );
  return res.status === 0;
}

function remoteTagState(tag) {
  const res = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    { encoding: "utf8" },
  );
  if (res.status === 0) return "exists";
  if (res.status === 2) return "missing";
  const detail = (res.stderr || res.stdout || "").trim();
  throw new Error(
    `git ls-remote failed with exit code ${res.status}${detail ? `: ${detail}` : ""}`,
  );
}

const version = readRootVersion();
const tag = `v${version}`;
const forceTag = process.env.FORCE_TAG === "true";
const dryRun = process.env.DRY_RUN === "1";

const state = remoteTagState(tag);
if (state === "exists") {
  console.log(`::notice::Tag ${tag} already tagged on origin; skipping.`);
  process.exit(0);
}

const parentVersion = readParentVersion();
const parentAdopted = hasParentAdoptedChangesets();
const versionChanged =
  parentAdopted && parentVersion !== null && parentVersion !== version;

if (!versionChanged && !forceTag) {
  if (!parentAdopted && parentVersion !== null && parentVersion !== version) {
    console.log(
      `::notice::Parent commit predates Changesets adoption (no .changeset/config.json); treating version ${parentVersion} -> ${version} as baseline, not tagging ${tag}.`,
    );
  } else {
    console.log(
      `::notice::Version ${version} unchanged vs parent (${parentVersion ?? "none"}), not tagging ${tag}.`,
    );
  }
  process.exit(0);
}

if (dryRun) {
  console.log(
    `::notice::[DRY_RUN] Would create and push tag ${tag} (parent=${parentVersion ?? "none"}, force=${forceTag}).`,
  );
  process.exit(0);
}

execFileSync("git", ["tag", "-a", tag, "-m", tag], { stdio: "inherit" });
execFileSync("git", ["push", "origin", `refs/tags/${tag}`], {
  stdio: "inherit",
});
console.log(`::notice::Created and pushed tag ${tag}.`);
