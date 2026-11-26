import { readFileSync, writeFileSync } from "node:fs";

function writeJsonPreservingEol(filePath, mutate) {
  const raw = readFileSync(filePath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const data = JSON.parse(raw);
  mutate(data);
  let out = `${JSON.stringify(data, null, 2)}\n`;
  if (eol === "\r\n") {
    out = out.replace(/\n/g, "\r\n");
  }
  writeFileSync(filePath, out, "utf8");
}

const workerPkg = JSON.parse(readFileSync("apps/worker/package.json", "utf8"));
const version = workerPkg.version?.trim();
if (!version) {
  throw new Error("apps/worker/package.json is missing version");
}

const semverMatch = version.match(/^(\d+)\.(\d+)\.\d+/);
if (!semverMatch) {
  throw new Error(`Invalid semver version in apps/worker/package.json: ${version}`);
}
const actorVersion = `${semverMatch[1]}.${semverMatch[2]}`;

writeJsonPreservingEol("package.json", (pkg) => {
  pkg.version = version;
});

writeJsonPreservingEol("apps/apify-crawler/package-lock.json", (lock) => {
  lock.version = version;
  if (lock.packages && lock.packages[""]) {
    lock.packages[""].version = version;
  }
});

writeJsonPreservingEol("apps/apify-crawler/.actor/actor.json", (actor) => {
  const curMatch = String(actor.version ?? "").match(/^(\d+)\.(\d+)$/);
  if (!curMatch) {
    actor.version = actorVersion;
    return;
  }
  const curMajor = Number(curMatch[1]);
  const curMinor = Number(curMatch[2]);
  const nextMajor = Number(semverMatch[1]);
  const nextMinor = Number(semverMatch[2]);
  if (nextMajor > curMajor || (nextMajor === curMajor && nextMinor > curMinor)) {
    actor.version = actorVersion;
  } else {
    console.log(
      `Keeping apps/apify-crawler/.actor/actor.json version at ${actor.version} (skipping downgrade/repeat to ${actorVersion}).`,
    );
  }
});

console.log(`Synced version ${version} (actor=${actorVersion}) across manifests.`);
