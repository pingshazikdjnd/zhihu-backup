import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function updateFenceState(line, state) {
  const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (state.char) {
    if (
      fenceMatch &&
      fenceMatch[1][0] === state.char &&
      fenceMatch[1].length >= state.len &&
      fenceMatch[2].trim() === ""
    ) {
      return { char: "", len: 0, inFence: true };
    }
    return { ...state, inFence: true };
  }
  if (fenceMatch) {
    return {
      char: fenceMatch[1][0],
      len: fenceMatch[1].length,
      inFence: true,
    };
  }
  return { char: "", len: 0, inFence: false };
}

function extractSection(markdown, version) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const targetHeading = `## ${version}`;
  let fence = { char: "", len: 0, inFence: false };
  let capturing = false;
  const captured = [];

  for (const line of lines) {
    fence = updateFenceState(line, fence);
    if (fence.inFence) {
      if (capturing) captured.push(line);
      continue;
    }

    if (!capturing) {
      if (line.trimEnd() === targetHeading) {
        capturing = true;
      }
      continue;
    }

    if (/^## /.test(line)) {
      break;
    }
    captured.push(line);
  }

  return captured;
}

function cleanUpdatedDependencies(lines) {
  const filtered = [];
  let skippingUpdatedDeps = false;
  let fence = { char: "", len: 0, inFence: false };

  for (const line of lines) {
    if (fence.char) {
      fence = updateFenceState(line, fence);
      if (!skippingUpdatedDeps) {
        filtered.push(line);
      }
      continue;
    }

    if (skippingUpdatedDeps) {
      if (/^[ \t]+/.test(line) || line.trim() === "") {
        fence = updateFenceState(line, fence);
        continue;
      }
      skippingUpdatedDeps = false;
    }

    fence = updateFenceState(line, fence);
    if (fence.inFence) {
      filtered.push(line);
      continue;
    }

    if (/^[-*]\s+Updated dependencies\b/.test(line)) {
      skippingUpdatedDeps = true;
      continue;
    }

    filtered.push(line);
  }

  // Prune empty level-3 headings (e.g. `### Patch Changes` with only dependency bumps)
  const blocks = [];
  let currentSubheading = null;
  let currentBody = [];
  let pruneFence = { char: "", len: 0, inFence: false };

  const flush = () => {
    if (currentSubheading === null) {
      blocks.push(...currentBody);
    } else if (currentBody.some((l) => l.trim() !== "")) {
      blocks.push(currentSubheading, ...currentBody);
    }
  };

  for (const line of filtered) {
    pruneFence = updateFenceState(line, pruneFence);
    if (!pruneFence.inFence && /^### /.test(line)) {
      flush();
      currentSubheading = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return blocks.join("\n").trim();
}

function resolvePackageName(changelogPath) {
  const dir = path.dirname(path.resolve(changelogPath));
  const pkgPath = path.join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name && typeof pkg.name === "string") {
        return pkg.name;
      }
    } catch {
      // Fall back to directory name
    }
  }
  return path.basename(dir);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error(
    "Usage: node release-notes.mjs <version> <CHANGELOG path...>",
  );
  process.exit(1);
}

const version = args[0].replace(/^v/, "");
const changelogPaths = args.slice(1);
const multiFile = changelogPaths.length > 1;
const sections = [];

for (const filePath of changelogPaths) {
  if (!existsSync(filePath)) {
    console.error(`Warning: changelog file not found, skipping: ${filePath}`);
    continue;
  }

  const content = readFileSync(filePath, "utf8");
  const rawLines = extractSection(content, version);
  const body = cleanUpdatedDependencies(rawLines);
  if (!body || body === "No changes in this release.") {
    continue;
  }

  if (multiFile) {
    const pkgName = resolvePackageName(filePath);
    sections.push(`## ${pkgName}\n\n${body}`);
  } else {
    sections.push(body);
  }
}

if (sections.length === 0) {
  console.log("本版本无面向用户的变更。");
} else {
  console.log(sections.join("\n\n"));
}
