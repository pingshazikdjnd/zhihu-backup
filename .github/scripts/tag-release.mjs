import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function readRootVersion() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if (!pkg.version || typeof pkg.version !== "string") {
    throw new Error("Root package.json is missing a valid version field");
  }
  return pkg.version.trim();
}

function readAdoptionBaselineVersion() {
  const logRes = spawnSync(
    "git",
    [
      "log",
      "--reverse",
      "--diff-filter=A",
      "--format=%H",
      "--",
      ".changeset/config.json",
    ],
    { encoding: "utf8" },
  );
  if (logRes.status !== 0) {
    return null;
  }
  const firstSha = logRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (!firstSha) {
    return null;
  }

  const pkgRes = spawnSync("git", ["show", `${firstSha}:package.json`], {
    encoding: "utf8",
  });
  if (pkgRes.status !== 0) {
    return null;
  }
  try {
    const pkg = JSON.parse(pkgRes.stdout);
    return typeof pkg.version === "string" ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function gitAuthEnv() {
  const token = process.env.GH_TOKEN;
  if (!token) {
    return process.env;
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const authHeader = `AUTHORIZATION: basic ${basic}`;
  const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  const baseCount = Number.isInteger(count) && count >= 0 ? count : 0;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(baseCount + 2),
    [`GIT_CONFIG_KEY_${baseCount}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${baseCount}`]: "",
    [`GIT_CONFIG_KEY_${baseCount + 1}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${baseCount + 1}`]: authHeader,
  };
}

function remoteTagState(tag) {
  const res = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    { encoding: "utf8", env: gitAuthEnv() },
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

const baselineVersion = readAdoptionBaselineVersion() ?? version;
const versionChanged = baselineVersion !== version;

if (!versionChanged && !forceTag) {
  console.log(
    `::notice::Version ${version} matches Changesets adoption baseline (${baselineVersion}); not tagging ${tag}.`,
  );
  process.exit(0);
}

if (dryRun) {
  console.log(
    `::notice::[DRY_RUN] Would create and push tag ${tag} (baseline=${baselineVersion}, force=${forceTag}).`,
  );
  process.exit(0);
}

const authEnv = gitAuthEnv();
execFileSync("git", ["tag", "-a", tag, "-m", tag], { stdio: "inherit" });
execFileSync("git", ["push", "origin", `refs/tags/${tag}`], {
  stdio: "inherit",
  env: authEnv,
});
console.log(`::notice::Created and pushed tag ${tag}.`);
