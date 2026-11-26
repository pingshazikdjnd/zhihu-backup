import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BUMP_RANK = { major: 3, minor: 2, patch: 1 };
const PATH_PACKAGE_MAP = [
  ["apps/worker/", "worker"],
  ["apps/web/", "web"],
  ["apps/apify-crawler/", "apify-crawler"],
  ["packages/shared/", "shared"],
];

function parseArgs(argv) {
  let defaultPkg = "";
  let mapPaths = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package" && i + 1 < argv.length) {
      defaultPkg = argv[++i].trim();
    } else if (arg === "--map-paths") {
      mapPaths = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!defaultPkg) {
    throw new Error(
      "Usage: node auto-changeset.mjs --package <name> [--map-paths] [--dry-run]",
    );
  }
  return { defaultPkg, mapPaths, dryRun };
}

function git(args, allowFailure = false) {
  const res = spawnSync("git", args, { encoding: "utf8" });
  if (res.status !== 0 && !allowFailure) {
    const err = (res.stderr || res.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${err}`);
  }
  return res;
}

function higherBump(a, b) {
  if (!a) return b;
  if (!b) return a;
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

/** Remove fenced code blocks before scanning commit/PR text for footers. */
function stripFencedCodeBlocks(text) {
  if (!text) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  let fenceChar = "";
  let fenceLen = 0;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceChar) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fenceChar &&
        fenceMatch[1].length >= fenceLen &&
        fenceMatch[2].trim() === ""
      ) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    if (fenceMatch) {
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n");
}

function hasBreakingChangeNotice(text) {
  return /^BREAKING[ -]CHANGE:/m.test(stripFencedCodeBlocks(text));
}

function classifyHeader(subject, extraText = "") {
  const trimmed = subject.trim();
  const hasBreakingBody = hasBreakingChangeNotice(extraText);

  if (/^Revert\s+".+"/.test(trimmed)) {
    return { matched: true, bump: hasBreakingBody ? "major" : "patch" };
  }

  const m = trimmed.match(
    /^(feat|fix|perf|revert|refactor|docs|chore|ci|build|test|style)(?:\(([^)]+)\))?(!)?\s*[:：]\s*(.+)$/i,
  );
  if (!m) {
    return { matched: false, bump: hasBreakingBody ? "major" : null };
  }

  const type = m[1].toLowerCase();
  const bang = Boolean(m[3]);
  if (bang || hasBreakingBody) {
    return { matched: true, bump: "major" };
  }
  if (type === "feat") {
    return { matched: true, bump: "minor" };
  }
  if (type === "fix" || type === "perf" || type === "revert") {
    return { matched: true, bump: "patch" };
  }
  return { matched: true, bump: null };
}

function fetchPrMeta(prNum) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) return null;

  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${repo}/pulls/${prNum}`, "--jq", "{title, body}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.title === "string") {
      return {
        title: parsed.title.trim(),
        body: typeof parsed.body === "string" ? parsed.body : "",
      };
    }
  } catch {
    // Fall back to git merge commit metadata
  }
  return null;
}

function readPrCommitLog(sha) {
  const res = git(
    ["log", "--format=%s%x1f%b%x1e", `${sha}^1..${sha}^2`],
    true,
  );
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sub = "", bod = ""] = rec.split("\x1f");
      return { subject: sub.trim(), body: bod.trim() };
    });
}

function getCommitChangedFiles(sha, diffFilter = "") {
  const args = [
    "-c",
    "core.quotePath=false",
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-m",
    "--first-parent",
  ];
  if (diffFilter) {
    args.push(`--diff-filter=${diffFilter}`);
  }
  args.push(sha);
  const res = git(args, true);
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function analyzeCommit(sha) {
  const addedFiles = getCommitChangedFiles(sha, "A");
  if (
    addedFiles.some((f) => /^\.changeset\/(?!README\.md$).+\.md$/.test(f))
  ) {
    return null;
  }

  const subject = git(["show", "-s", "--format=%s", sha]).stdout.trim();
  const body = git(["show", "-s", "--format=%b", sha]).stdout.trim();

  if (
    /^chore\(release\):/i.test(subject) ||
    /^Merge pull request #\d+ from [^/]+\/changeset-release\//i.test(subject)
  ) {
    return null;
  }

  const mergeMatch = subject.match(/^Merge pull request #(\d+)\b/);
  if (mergeMatch) {
    const prNum = mergeMatch[1];
    const prMeta = fetchPrMeta(prNum);
    const prCommits = readPrCommitLog(sha);
    const bodyTitle = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    const rawTitle =
      prMeta?.title || bodyTitle || prCommits[0]?.subject || subject;
    const prBody = [prMeta?.body || "", body].join("\n");

    const header = classifyHeader(rawTitle, prBody);
    let bump = header.bump;
    // Only fall back to branch commits when the PR title lacks a Conventional Commit prefix
    if (!header.matched) {
      for (const c of prCommits) {
        bump = higherBump(bump, classifyHeader(c.subject, c.body).bump);
      }
    }
    if (!bump) return null;

    const suffix = ` (#${prNum})`;
    const summary = rawTitle.endsWith(suffix)
      ? rawTitle
      : `${rawTitle}${suffix}`;
    return { bump, summary };
  }

  const squashPrMatch = subject.match(/\(#(\d+)\)$/);
  const prMeta = squashPrMatch ? fetchPrMeta(squashPrMatch[1]) : null;
  const extraText = prMeta?.body ? `${prMeta.body}\n${body}` : body;
  const { bump } = classifyHeader(subject, extraText);
  if (!bump) return null;
  return { bump, summary: subject };
}

function resolvePackages(sha, defaultPkg, mapPaths) {
  if (!mapPaths) return [defaultPkg];
  const files = getCommitChangedFiles(sha);
  const found = new Set();
  for (const file of files) {
    for (const [prefix, pkg] of PATH_PACKAGE_MAP) {
      if (file.startsWith(prefix)) {
        found.add(pkg);
      }
    }
  }
  return found.size > 0 ? [...found].sort() : [defaultPkg];
}

const { defaultPkg, mapPaths, dryRun } = parseArgs(process.argv.slice(2));
const rootPkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = rootPkg.version?.trim();
if (!version) {
  throw new Error("Root package.json is missing version");
}

const currentTag = `v${version}`;
const tagCheck = git(["rev-parse", "-q", "--verify", `refs/tags/${currentTag}`], true);
if (tagCheck.status !== 0) {
  console.log(
    `::notice::Tag ${currentTag} does not exist yet (pending tag release); skipping auto-changeset.`,
  );
  process.exit(0);
}

const commitListRaw = git([
  "log",
  "--first-parent",
  "--reverse",
  "--format=%H",
  `${currentTag}..HEAD`,
]).stdout;
const commits = commitListRaw
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

if (commits.length === 0) {
  console.log(`::notice::No commits since ${currentTag}.`);
  process.exit(0);
}

let generated = 0;
if (!dryRun) {
  mkdirSync(".changeset", { recursive: true });
}

for (const sha of commits) {
  const result = analyzeCommit(sha);
  if (!result) continue;

  const pkgs = resolvePackages(sha, defaultPkg, mapPaths);
  const frontmatter = pkgs.map((p) => `"${p}": ${result.bump}`).join("\n");
  const cleanSummary = result.summary.replace(/\r?\n+/g, " ").trim();
  const content = `---\n${frontmatter}\n---\n\n${cleanSummary}\n`;
  const targetPath = path.join(".changeset", `auto-${sha.slice(0, 8)}.md`);

  if (dryRun) {
    console.log(`[DRY_RUN] ${targetPath}\n${content}`);
  } else {
    writeFileSync(targetPath, content, "utf8");
  }
  generated++;
}

if (generated === 0) {
  console.log(`::notice::No releasable commits since ${currentTag}.`);
} else {
  console.log(
    `::notice::Generated ${generated} auto-changeset(s) since ${currentTag}.`,
  );
}
