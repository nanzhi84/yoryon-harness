import fs from "node:fs";
import path from "node:path";

export const RULES = {
  HAR001: {
    code: "HAR001",
    title: "Missing core Harness directory or entry document",
    summary:
      "Ensures README.md, AGENTS.md, PROJECTS.md, CHANGELOG.md, docs/README.md, docs/architecture/overview.md, docs/reference/INDEX.md, and the five docs/ subdirectories exist.",
    fix: "Run `harness init` to create missing directories and baseline files.",
  },
  GIT001: {
    code: "GIT001",
    title: "Sandbox directories not ignored in .gitignore",
    summary:
      "Ensures `work/` and `artifacts/` are listed in `.gitignore` so temporary execution data and verification artifacts are never committed.",
    fix: "Run `harness sync` or add `work/` and `artifacts/` to `.gitignore`.",
  },
  ARC001: {
    code: "ARC001",
    title: "Architecture overview missing required Mermaid diagrams",
    summary:
      "`docs/architecture/overview.md` must include at least two `mermaid` diagram blocks (Module Boundary diagram and Core Execution Flow diagram).",
    fix: "Add the two required ```mermaid blocks (module boundary flowchart and core execution flow diagram) in `docs/architecture/overview.md`.",
  },
  SPC001: {
    code: "SPC001",
    title: "Invalid spec directory naming or missing spec document",
    summary:
      "Entries inside `docs/spec/` must be issue-aligned directories named `issue#<N>/` (e.g., `issue#1/`, `issue#15/`) and contain at least one `.md` file.",
    fix: "Use `harness spec new <issue-number>` to create `docs/spec/issue#<N>/spec.md`.",
  },
  ADR001: {
    code: "ADR001",
    title: "Invalid ADR filename convention",
    summary:
      "ADR documents in `docs/adr/` and `docs/adr/superseded/` must use a 4-digit prefix: `NNNN-<slug>.md`.",
    fix: "Rename the file to `NNNN-<slug>.md` (e.g., `0001-use-postgres.md`) or create ADRs with `harness adr new`.",
  },
  ADR002: {
    code: "ADR002",
    title: "ADR lifecycle status and directory placement mismatch",
    summary:
      "ADRs marked `Superseded` must be archived in `docs/adr/superseded/` with a failure/sunset explanation, while active ADRs stay in `docs/adr/`.",
    fix: "Run `harness adr supersede <old-id> <new-id>` or move the superseded ADR to `docs/adr/superseded/`.",
  },
  REF001: {
    code: "REF001",
    title: "Unindexed file in docs/reference/",
    summary:
      "Every file stored in `docs/reference/` (except `INDEX.md`) must be registered in the 3-column `docs/reference/INDEX.md` table.",
    fix: "Add an entry (`| 文件路径 | 来源链接 / 背景说明 | 备注 |`) in `docs/reference/INDEX.md`.",
  },
  LNK001: {
    code: "LNK001",
    title: "Missing local link target or case mismatch",
    summary:
      "Reports local Markdown links or images whose target does not exist on disk or whose filename case differs from disk.",
    fix: "Update the link path to match the exact relative or root-relative file path on disk.",
  },
  LNK002: {
    code: "LNK002",
    title: "Missing local link anchor",
    summary:
      "Reports `#fragment` links whose heading slug or HTML anchor id does not exist in the target Markdown document.",
    fix: "Update the `#anchor` fragment to match an existing heading in the target Markdown file.",
  },
  VOX001: {
    code: "VOX001",
    title: "AI conversation remnants in long-lived documentation",
    summary:
      "Detects chat-transcript phrases addressing the prompt requester (e.g., '根据你的要求', '按您的要求', 'As you requested') in long-lived documents.",
    fix: "Rewrite the sentence to describe the system or procedure directly without referencing the conversation.",
  },
  SUP001: {
    code: "SUP001",
    title: "Invalid or unreasoned harness-ignore suppression",
    summary:
      "Suppression comments must follow `<!-- harness-ignore CODE: reason -->` (or `# harness-ignore CODE: reason` / `// harness-ignore CODE: reason` in test files) with a valid rule code and a non-empty reason.",
    fix: "Format the comment as `<!-- harness-ignore CODE: explain why this exception is needed -->` (or `# harness-ignore CODE: reason` in code).",
  },
  TST001: {
    code: "TST001",
    title: "Invalid test file naming or missing Test<Subject> class hierarchy",
    summary:
      "Test files in `tests/` must be named by domain capability (`tests/test_<domain>.py`, never `test_phase1.py` or `test1.py`) and group Python test functions inside `class Test<Subject>:` with `def test_<scenario>_<expected>()`.",
    fix: "Rename the file to `tests/test_<domain>.py` and wrap top-level `def test_*` functions inside `class Test<Subject>:` with two-part `def test_<scenario>_<expected>()` names.",
  },
  TST002: {
    code: "TST002",
    title: "Forbidden mocking or monkeypatching of business logic in tests",
    summary:
      "Detects mocking frameworks and attribute monkeypatching (`unittest.mock`, `MagicMock`, `AsyncMock`, `@patch`, `mocker.patch`, `monkeypatch.setattr`, `jest.mock`, `vi.mock`, `sinon.stub`) in `tests/`. Environment variable overrides like `monkeypatch.setenv` / `monkeypatch.delenv` are allowed.",
    fix: "Replace mocks/stubs with real black-box fixtures or local test servers, or add `# harness-ignore TST002: <reason>` (or `// harness-ignore TST002: <reason>`) if justified.",
  },
};

const IGNORED_WALK_DIRS = new Set([
  ".git",
  "node_modules",
  "work",
  "artifacts",
  "dist",
  "build",
  ".next",
  "target",
]);

const CONVERSATION_REMNANT_PATTERNS = [
  /根据(?:你|您)的要求/,
  /按照?(?:你|您)的要求/,
  /正如(?:我们|刚才)(?:所)?讨论/,
  /按(?:你|您)刚才说的/,
  /我已经为(?:你|您)/,
  /已为(?:你|您)(?:更新|整理|修改|完成)/,
  /以下是(?:更新|整理|修改)后的/,
  /希望这对(?:你|您)有帮助/,
  /如果(?:你|您)还有(?:其他|任何)问题/,
  /\bas you requested\b/i,
  /\bas we discussed earlier\b/i,
  /\bhere(?:'s| is) the updated\b/i,
  /\bi have updated the\b/i,
  /\blet me know if you (?:need|have)\b/i,
  /\bhope this helps\b/i,
];

/**
 * Case-sensitive existence check on macOS/Windows/Linux by verifying each path segment against readdirSync.
 */
function checkExactCasePath(rootDir, targetAbsPath) {
  if (!fs.existsSync(targetAbsPath)) {
    return { exists: false, caseMismatch: null };
  }
  const rel = path.relative(rootDir, targetAbsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { exists: true, caseMismatch: null };
  }
  const segments = rel.split(path.sep).filter(Boolean);
  let current = rootDir;
  for (const seg of segments) {
    const entries = fs.readdirSync(current);
    if (!entries.includes(seg)) {
      const actual = entries.find((e) => e.toLowerCase() === seg.toLowerCase());
      return {
        exists: false,
        caseMismatch: actual
          ? path.join(path.relative(rootDir, current), actual)
          : null,
      };
    }
    current = path.join(current, seg);
  }
  return { exists: true, caseMismatch: null };
}

/**
 * Compute GitHub-flavored Markdown heading slug (supports ASCII + CJK characters).
 */
export function githubSlug(rawHeading) {
  const cleaned = rawHeading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\{#[^}]+\}\s*$/, "")
    .trim()
    .toLowerCase();

  return cleaned
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * Extract all valid anchor IDs from a Markdown document.
 */
export function extractMarkdownAnchors(content) {
  const anchors = new Set();
  const slugCounts = new Map();
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;

    // HTML id or name attributes
    const htmlIdRegex = /\b(?:id|name)=["']([^"']+)["']/gi;
    let idMatch;
    while ((idMatch = htmlIdRegex.exec(line)) !== null) {
      anchors.add(idMatch[1]);
    }

    // Markdown ATX headings
    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      let headingText = headingMatch[2];
      // Custom heading ID: {#custom-id}
      const customIdMatch = headingText.match(/\{#([a-zA-Z0-9_-]+)\}\s*$/);
      if (customIdMatch) {
        anchors.add(customIdMatch[1]);
        headingText = headingText.replace(/\{#[^}]+\}\s*$/, "").trim();
      }
      const baseSlug = githubSlug(headingText);
      if (baseSlug) {
        const count = slugCounts.get(baseSlug) || 0;
        if (count === 0) {
          anchors.add(baseSlug);
        } else {
          anchors.add(`${baseSlug}-${count}`);
        }
        slugCounts.set(baseSlug, count + 1);
      }
    }
  }

  return anchors;
}

/**
 * Strip inline code spans from a single line while preserving character offsets.
 */
function maskInlineCode(line) {
  return line.replace(/`+[^`]*`+/g, (m) => " ".repeat(m.length));
}

/**
 * Parse inline suppression comments (`<!-- harness-ignore CODE: reason -->`) and prose checks.
 */
function scanMarkdownTextAndSuppressions(content) {
  const lines = content.split(/\r?\n/);
  const suppressedRules = new Set();
  const issues = [];

  let inFence = false;
  let fenceChar = "";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;

    const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
      } else if (char === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) continue;

    const masked = maskInlineCode(rawLine);

    // Check suppression comments outside inline code: <!-- harness-ignore ... -->
    const supMatch = masked.match(/<!--\s*harness-ignore\b([\s\S]*?)-->/);
    if (supMatch) {
      const body = supMatch[1].trim();
      const parsed = body.match(/^([A-Z]{3}\d{3})\s*:\s*(.+)$/);
      if (!parsed || !RULES[parsed[1]] || !parsed[2].trim()) {
        issues.push({
          code: "SUP001",
          line: lineNum,
          message:
            "Invalid `harness-ignore` comment; must specify a valid rule code and reason (`<!-- harness-ignore CODE: reason -->`).",
        });
      } else {
        suppressedRules.add(parsed[1]);
      }
      continue;
    }

    // Skip blockquotes and HTML comments for VOX001 prose checks
    if (/^\s*>/.test(rawLine) || /^\s*<!--/.test(masked)) continue;
    for (const pattern of CONVERSATION_REMNANT_PATTERNS) {
      const m = masked.match(pattern);
      if (m) {
        issues.push({
          code: "VOX001",
          line: lineNum,
          message: `Found conversation remnant '${m[0]}' in long-lived document.`,
        });
        break;
      }
    }
  }

  return { suppressedRules, issues };
}

/**
 * Extract local links from a Markdown document with line numbers.
 */
export function extractMarkdownLinks(content) {
  const lines = content.split(/\r?\n/);
  const links = [];
  const refDefs = new Map();
  const refUses = [];

  let inFence = false;
  let fenceChar = "";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;

    const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
      } else if (char === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) continue;

    const masked = maskInlineCode(rawLine);

    // Reference definition: [id]: target "optional title"
    const refDefMatch = masked.match(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/);
    if (refDefMatch) {
      const id = refDefMatch[1].trim().toLowerCase();
      const target = refDefMatch[2].trim();
      refDefs.set(id, { target, line: lineNum });
      links.push({ target, line: lineNum });
      continue;
    }

    // Inline links & images: ![alt](target) or [label](target)
    const inlineRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = inlineRegex.exec(masked)) !== null) {
      let inner = match[1].trim();
      if (inner.startsWith("<") && inner.includes(">")) {
        inner = inner.slice(1, inner.indexOf(">"));
      } else {
        inner = inner.split(/\s+/)[0];
      }
      if (inner) {
        links.push({ target: inner, line: lineNum });
      }
    }

    // Reference link usage: [label][id]
    const refUseRegex = /!?\[([^\]]+)\]\[([^\]]*)\]/g;
    let rMatch;
    while ((rMatch = refUseRegex.exec(masked)) !== null) {
      const id = (rMatch[2] || rMatch[1]).trim().toLowerCase();
      refUses.push({ id, line: lineNum });
    }
  }

  for (const use of refUses) {
    if (refDefs.has(use.id)) {
      const def = refDefs.get(use.id);
      links.push({ target: def.target, line: use.line });
    }
  }

  return links;
}

/**
 * Walk workspace to collect all Markdown files.
 */
function collectMarkdownFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_WALK_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Run all Harness checks on `targetRoot` and return structured diagnostics.
 */
export function checkWorkspace(targetRoot = process.cwd()) {
  const diagnostics = [];
  const addDiag = (code, relFile, line, message, fix) => {
    diagnostics.push({
      code,
      file: relFile,
      line: line || 1,
      message,
      fix: fix || RULES[code]?.fix || "",
    });
  };

  // 1. HAR001: Required directories and core entry files
  const requiredDirs = [
    "docs/architecture",
    "docs/spec",
    "docs/adr",
    "docs/adr/superseded",
    "docs/runbooks",
    "docs/reference",
  ];
  for (const d of requiredDirs) {
    const abs = path.join(targetRoot, d);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      addDiag("HAR001", d, 1, `Missing required directory '${d}/'.`);
    }
  }

  const requiredFiles = [
    "README.md",
    "AGENTS.md",
    "PROJECTS.md",
    "CHANGELOG.md",
    "docs/README.md",
    "docs/architecture/overview.md",
    "docs/reference/INDEX.md",
  ];
  for (const f of requiredFiles) {
    const abs = path.join(targetRoot, f);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      addDiag("HAR001", f, 1, `Missing required entry file '${f}'.`);
    }
  }

  // 2. GIT001: .gitignore must ignore work/ and artifacts/
  const gitignorePath = path.join(targetRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    addDiag(
      "GIT001",
      ".gitignore",
      1,
      "Missing `.gitignore`; `work/` and `artifacts/` must be ignored."
    );
  } else {
    const gitignoreLines = fs
      .readFileSync(gitignorePath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    for (const sandbox of ["work/", "artifacts/"]) {
      const bare = sandbox.replace(/\/$/, "");
      if (
        !gitignoreLines.includes(sandbox) &&
        !gitignoreLines.includes(bare) &&
        !gitignoreLines.includes(`/${sandbox}`)
      ) {
        addDiag(
          "GIT001",
          ".gitignore",
          1,
          `Sandbox directory '${sandbox}' is not ignored in .gitignore.`
        );
      }
    }
  }

  // 3. ARC001: docs/architecture/overview.md must contain at least 2 mermaid diagrams
  const archOverviewPath = path.join(targetRoot, "docs/architecture/overview.md");
  if (fs.existsSync(archOverviewPath) && fs.statSync(archOverviewPath).isFile()) {
    const archContent = fs.readFileSync(archOverviewPath, "utf8");
    const mermaidBlocks = archContent.match(/^\s*`{3,}\s*mermaid\b/gim) || [];
    if (mermaidBlocks.length < 2) {
      addDiag(
        "ARC001",
        "docs/architecture/overview.md",
        1,
        `Expected at least 2 Mermaid diagrams in 'docs/architecture/overview.md' (found ${mermaidBlocks.length}).`
      );
    }
  }

  // 4. SPC001: docs/spec/ issue#<N> naming and structure
  const specDir = path.join(targetRoot, "docs/spec");
  if (fs.existsSync(specDir) && fs.statSync(specDir).isDirectory()) {
    const entries = fs.readdirSync(specDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".gitkeep" || entry.name === ".DS_Store") continue;
      const relEntry = `docs/spec/${entry.name}`;
      if (!entry.isDirectory()) {
        addDiag(
          "SPC001",
          relEntry,
          1,
          `Spec entry '${entry.name}' must be an issue directory named 'issue#<N>/', not a flat file.`,
          `Create an issue folder via \`harness spec new <issue-number>\` and move '${entry.name}' inside it.`
        );
        continue;
      }
      if (!/^issue#\d+$/i.test(entry.name)) {
        addDiag(
          "SPC001",
          relEntry,
          1,
          `Spec directory '${entry.name}' does not match 'issue#<N>' format (e.g., 'issue#1', 'issue#15').`
        );
      } else {
        const innerFiles = fs.readdirSync(path.join(specDir, entry.name));
        if (!innerFiles.some((f) => f.endsWith(".md"))) {
          addDiag(
            "SPC001",
            relEntry,
            1,
            `Spec directory '${entry.name}/' does not contain any Markdown (.md) document (such as 'spec.md').`
          );
        }
      }
    }
  }

  // 5. ADR001 & ADR002: docs/adr/ and docs/adr/superseded/
  const adrDir = path.join(targetRoot, "docs/adr");
  if (fs.existsSync(adrDir) && fs.statSync(adrDir).isDirectory()) {
    const checkAdrFolder = (folderAbs, isSupersededFolder) => {
      if (!fs.existsSync(folderAbs)) return;
      const entries = fs.readdirSync(folderAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".gitkeep" || entry.name === ".DS_Store") continue;
        if (!isSupersededFolder && entry.isDirectory() && entry.name === "superseded") {
          continue;
        }
        const relPath = path.relative(targetRoot, path.join(folderAbs, entry.name));
        if (entry.isDirectory()) {
          addDiag(
            "ADR001",
            relPath,
            1,
            `Unexpected directory '${entry.name}' inside ADR folder; only 'superseded/' is allowed.`
          );
          continue;
        }
        if (!/^\d{4}-[a-z0-9-]+\.md$/i.test(entry.name)) {
          addDiag(
            "ADR001",
            relPath,
            1,
            `ADR filename '${entry.name}' must match 4-digit format 'NNNN-<slug>.md'.`
          );
          continue;
        }
        const content = fs.readFileSync(path.join(folderAbs, entry.name), "utf8");
        const hasSupersededStatus =
          /(?:状态|Status)[^\r\n:：]*[:：]\s*.*Superseded/i.test(content) ||
          /^Superseded by\b/im.test(content);

        if (!isSupersededFolder && hasSupersededStatus) {
          addDiag(
            "ADR002",
            relPath,
            1,
            `ADR '${entry.name}' is marked Superseded but still sits in active 'docs/adr/'.`,
            `Move '${relPath}' to 'docs/adr/superseded/${entry.name}' or run \`harness adr supersede\`.`
          );
        } else if (isSupersededFolder && !hasSupersededStatus) {
          addDiag(
            "ADR002",
            relPath,
            1,
            `Archived ADR '${entry.name}' in 'docs/adr/superseded/' must declare 'Superseded' status in its metadata.`
          );
        }
      }
    };

    checkAdrFolder(adrDir, false);
    checkAdrFolder(path.join(adrDir, "superseded"), true);
  }

  // 6. REF001: docs/reference/ files must be registered in docs/reference/INDEX.md
  const refDir = path.join(targetRoot, "docs/reference");
  const refIndex = path.join(refDir, "INDEX.md");
  if (
    fs.existsSync(refDir) &&
    fs.statSync(refDir).isDirectory() &&
    fs.existsSync(refIndex)
  ) {
    const indexContent = fs.readFileSync(refIndex, "utf8");
    const walkRef = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".gitkeep" || entry.name === ".DS_Store") continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkRef(abs);
        } else {
          const relToRef = path.relative(refDir, abs).split(path.sep).join("/");
          if (relToRef === "INDEX.md") continue;
          if (!indexContent.includes(relToRef) && !indexContent.includes(entry.name)) {
            addDiag(
              "REF001",
              `docs/reference/${relToRef}`,
              1,
              `Reference file '${relToRef}' is not registered in 'docs/reference/INDEX.md'.`
            );
          }
        }
      }
    };
    walkRef(refDir);
  }

  // 7. LNK001, LNK002, VOX001, SUP001: Markdown link & text linting
  const mdFiles = collectMarkdownFiles(targetRoot);
  const anchorCache = new Map();
  const getAnchors = (absPath) => {
    if (!anchorCache.has(absPath)) {
      const text = fs.readFileSync(absPath, "utf8");
      anchorCache.set(absPath, extractMarkdownAnchors(text));
    }
    return anchorCache.get(absPath);
  };

  const templatesDir = path.join(targetRoot, "templates");

  for (const mdAbs of mdFiles) {
    const relFile = path.relative(targetRoot, mdAbs).split(path.sep).join("/");
    const content = fs.readFileSync(mdAbs, "utf8");

    // Text & suppression lint
    const { suppressedRules, issues } = scanMarkdownTextAndSuppressions(content);
    const isLongLivedDoc =
      !relFile.startsWith("docs/spec/") &&
      !relFile.startsWith("docs/adr/") &&
      relFile !== "CHANGELOG.md";

    for (const issue of issues) {
      if (issue.code === "VOX001" && !isLongLivedDoc) continue;
      if (suppressedRules.has(issue.code)) continue;
      addDiag(issue.code, relFile, issue.line, issue.message);
    }

    const links = extractMarkdownLinks(content);

    // Determine effective root (if file is inside templates/, root-relative links resolve inside templates/)
    const isInsideTemplates =
      mdAbs.startsWith(templatesDir + path.sep) && fs.existsSync(templatesDir);
    const effectiveRoot = isInsideTemplates ? templatesDir : targetRoot;

    for (const { target, line } of links) {
      // Skip external protocols
      if (
        /^(https?:|mailto:|tel:|data:|javascript:|conversation:)/i.test(target)
      ) {
        continue;
      }

      let rawPath = target;
      let fragment = "";

      // Same-file anchor link (#heading)
      if (rawPath.startsWith("#")) {
        fragment = rawPath.slice(1);
        rawPath = "";
      } else {
        // Split at the LAST '#' only if it occurs after the last '/' and is not part of a directory name like `issue#1`
        const lastSlash = rawPath.lastIndexOf("/");
        const lastHash = rawPath.lastIndexOf("#");
        if (lastHash > lastSlash) {
          const tailSegment = rawPath.slice(lastSlash + 1);
          if (!/^issue#\d+$/i.test(tailSegment)) {
            fragment = rawPath.slice(lastHash + 1);
            rawPath = rawPath.slice(0, lastHash);
          }
        }
      }

      // Strip query string if any
      const queryIdx = rawPath.indexOf("?");
      if (queryIdx !== -1) {
        rawPath = rawPath.slice(0, queryIdx);
      }

      // Handle file:// links
      if (rawPath.startsWith("file://")) {
        rawPath = decodeURIComponent(rawPath.replace(/^file:\/\//, ""));
      } else {
        try {
          rawPath = decodeURIComponent(rawPath);
        } catch {
          // keep as is if malformed URI escape
        }
      }

      // Same-file anchor link: (#section)
      if (!rawPath) {
        if (fragment && !suppressedRules.has("LNK002")) {
          const anchors = getAnchors(mdAbs);
          if (!anchors.has(fragment.toLowerCase()) && !anchors.has(fragment)) {
            addDiag(
              "LNK002",
              relFile,
              line,
              `Missing same-file heading anchor '#${fragment}'.`
            );
          }
        }
        continue;
      }

      // Resolve target path on disk
      let resolvedAbs;
      if (path.isAbsolute(rawPath) && fs.existsSync(rawPath)) {
        resolvedAbs = rawPath;
      } else if (rawPath.startsWith("/")) {
        resolvedAbs = path.join(effectiveRoot, rawPath.slice(1));
      } else {
        resolvedAbs = path.resolve(path.dirname(mdAbs), rawPath);
      }

      const check = checkExactCasePath(effectiveRoot, resolvedAbs);
      if (!check.exists) {
        if (!suppressedRules.has("LNK001")) {
          if (check.caseMismatch) {
            addDiag(
              "LNK001",
              relFile,
              line,
              `Link target '${rawPath}' differs in letter case from disk entry '${check.caseMismatch}'.`
            );
          } else {
            addDiag(
              "LNK001",
              relFile,
              line,
              `Broken local link '${target}': target '${path.relative(effectiveRoot, resolvedAbs)}' does not exist.`
            );
          }
        }
        continue;
      }

      // If fragment is present and target is a Markdown file, check LNK002
      if (
        fragment &&
        !suppressedRules.has("LNK002") &&
        fs.statSync(resolvedAbs).isFile() &&
        resolvedAbs.endsWith(".md")
      ) {
        if (/^L\d+(-L?\d+)?$/i.test(fragment)) {
          continue;
        }
        const anchors = getAnchors(resolvedAbs);
        if (!anchors.has(fragment.toLowerCase()) && !anchors.has(fragment)) {
          addDiag(
            "LNK002",
            relFile,
            line,
            `Broken anchor '#${fragment}' in link '${target}' (target '${path.relative(effectiveRoot, resolvedAbs)}' has no matching heading).`
          );
        }
      }
    }
  }

  // 8. TST001, TST002, and SUP001 in tests/
  const testsDir = path.join(targetRoot, "tests");
  if (fs.existsSync(testsDir) && fs.statSync(testsDir).isDirectory()) {
    const ignoredTestSubdirs = new Set([
      "__pycache__",
      ".pytest_cache",
      "fixtures",
      "node_modules",
    ]);
    const testCodeFiles = [];
    const walkTests = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".gitkeep" || entry.name === ".DS_Store") continue;
        if (entry.isDirectory()) {
          if (ignoredTestSubdirs.has(entry.name)) continue;
          walkTests(path.join(dir, entry.name));
        } else if (
          entry.isFile() &&
          /\.(?:py|js|mjs|cjs|ts)$/i.test(entry.name)
        ) {
          testCodeFiles.push(path.join(dir, entry.name));
        }
      }
    };
    walkTests(testsDir);

    const FORBIDDEN_MOCK_PATTERNS = [
      {
        regex: /\bunittest\.mock\b/,
        label: "unittest.mock",
      },
      {
        regex: /\b(?:MagicMock|AsyncMock|NonCallableMock|PropertyMock)\b/,
        label: "MagicMock/AsyncMock",
      },
      {
        regex: /@(?:unittest\.mock\.|mock\.)?patch\b/,
        label: "@patch decorator",
      },
      {
        regex: /\bpatch\.(?:object|dict|multiple)\s*\(/,
        label: "patch.object/dict/multiple",
      },
      {
        regex: /\bmocker\.(?:patch|spy|stub)\b/,
        label: "mocker.patch/spy/stub",
      },
      {
        regex: /\bmonkeypatch\.(?:setattr|delattr)\s*\(/,
        label: "monkeypatch.setattr/delattr",
      },
      {
        regex: /\b(?:jest|vi)\.(?:mock|spyOn|fn)\s*\(/,
        label: "jest/vi.mock/spyOn/fn",
      },
      {
        regex: /\bsinon\.(?:stub|mock|spy)\s*\(/,
        label: "sinon.stub/mock/spy",
      },
    ];

    for (const testAbs of testCodeFiles) {
      const relFile = path.relative(targetRoot, testAbs).split(path.sep).join("/");
      const baseName = path.basename(testAbs);
      const isPy = baseName.endsWith(".py");
      const content = fs.readFileSync(testAbs, "utf8");
      const lines = content.split(/\r?\n/);

      // Scan code comment suppressions: # harness-ignore CODE: reason or // harness-ignore CODE: reason
      const suppressedTestRules = new Set();
      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const trimmed = lines[i].trim();
        const commentMatch = trimmed.match(
          /^(?:#|\/\/|\/\*+)\s*harness-ignore\b(.*)$/
        );
        if (commentMatch) {
          const rawBody = commentMatch[1].replace(/\*+\/\s*$/, "").trim();
          const parsed = rawBody.match(/^([A-Z]{3}\d{3})\s*:\s*(.+)$/);
          if (!parsed || !RULES[parsed[1]] || !parsed[2].trim()) {
            addDiag(
              "SUP001",
              relFile,
              lineNum,
              "Invalid `harness-ignore` comment in test file; must specify a valid rule code and reason (`# harness-ignore CODE: reason`)."
            );
          } else {
            suppressedTestRules.add(parsed[1]);
          }
        }
      }

      // TST001: File naming & Python class/method hierarchy
      if (!suppressedTestRules.has("TST001")) {
        const isPyTestFile =
          isPy &&
          baseName !== "__init__.py" &&
          baseName !== "conftest.py" &&
          (/^test/i.test(baseName) ||
            /_test\.py$/i.test(baseName) ||
            /(?:^|\n)\s*(?:async\s+)?def\s+test_|(?:^|\n)\s*class\s+Test/.test(
              content
            ));

        const isPhaseOrNumberNamed =
          /^(?:test[_-]?)?(?:phase|step|stage|part|iter|sprint)[_-]?\d+/i.test(
            baseName
          ) ||
          /^test[_-]?\d+(?:[_.-]|$)/i.test(baseName) ||
          /(?:^|[._-])(?:phase|step|stage)[_-]?\d+\.(?:test|spec)\.[jt]s$/i.test(
            baseName
          );

        if (isPhaseOrNumberNamed) {
          addDiag(
            "TST001",
            relFile,
            1,
            `Test file '${baseName}' uses phase/step/sequence naming; name test files by domain capability (e.g., 'tests/test_<domain>.py').`
          );
        } else if (isPyTestFile && !/^test_[a-z][a-z0-9_]*\.py$/.test(baseName)) {
          addDiag(
            "TST001",
            relFile,
            1,
            `Python test file '${baseName}' must match 'tests/test_<domain>.py' domain naming convention.`
          );
        }

        if (isPyTestFile) {
          for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const rawLine = lines[i];
            if (/^\s*#/.test(rawLine)) continue;

            // Top-level test function (not inside class Test<Subject>:)
            const topDefMatch = rawLine.match(
              /^(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/
            );
            if (topDefMatch) {
              addDiag(
                "TST001",
                relFile,
                lineNum,
                `Top-level test function '${topDefMatch[1]}' must be grouped inside a 'class Test<Subject>:' hierarchy.`
              );
              continue;
            }

            // Indented test method inside class: require at least two parts after test_ (<scenario>_<expected>)
            const methodDefMatch = rawLine.match(
              /^\s+(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/
            );
            if (methodDefMatch) {
              const fnName = methodDefMatch[1];
              const suffix = fnName.slice("test_".length);
              if (!suffix.includes("_") || /^_+$/.test(suffix)) {
                addDiag(
                  "TST001",
                  relFile,
                  lineNum,
                  `Test method '${fnName}' must follow 'def test_<scenario>_<expected>()' naming covering both scenario and expected outcome.`
                );
              }
            }
          }
        }
      }

      // TST002: Forbidden mocking or business attribute monkeypatching
      if (!suppressedTestRules.has("TST002")) {
        for (let i = 0; i < lines.length; i++) {
          const lineNum = i + 1;
          const rawLine = lines[i];
          const trimmed = rawLine.trim();
          if (
            trimmed.startsWith("#") ||
            trimmed.startsWith("//") ||
            trimmed.startsWith("/*") ||
            trimmed.startsWith("*")
          ) {
            continue;
          }
          for (const pat of FORBIDDEN_MOCK_PATTERNS) {
            if (pat.regex.test(rawLine)) {
              addDiag(
                "TST002",
                relFile,
                lineNum,
                `Forbidden mock/monkeypatch usage (${pat.label}) detected in '${relFile}'; use real black-box fixtures or local test servers instead.`
              );
              break;
            }
          }
        }
      }
    }
  }

  return diagnostics;
}

/**
 * CLI runner for `harness doctor`.
 */
export function runDoctor(targetRoot = process.cwd(), options = {}) {
  const { json = false } = options;
  const diagnostics = checkWorkspace(targetRoot);

  if (json) {
    console.log(JSON.stringify({ ok: diagnostics.length === 0, diagnostics }, null, 2));
  } else if (diagnostics.length === 0) {
    console.log("✓ harness doctor: all structure, lifecycle, text, index, and link checks passed.");
  } else {
    console.error(`✗ harness doctor found ${diagnostics.length} issue(s):\n`);
    for (const d of diagnostics) {
      console.error(`${d.file}:${d.line} [${d.code}] ${d.message}`);
      if (d.fix) {
        console.error(`  fix: ${d.fix}`);
      }
    }
    console.error(
      `\ntip: run \`harness rule <CODE>\` for details, or add \`<!-- harness-ignore <CODE>: <reason> -->\` in Markdown if an exception is justified.`
    );
  }

  return diagnostics.length === 0 ? 0 : 1;
}

/**
 * Print rule documentation (`harness rule --all` or `harness rule <CODE>`).
 */
export function printRules(code) {
  if (!code || code === "--all") {
    for (const r of Object.values(RULES)) {
      console.log(`# ${r.code}: ${r.title}\n`);
      console.log(`What it checks: ${r.summary}`);
      console.log(`How to fix:     ${r.fix}\n`);
    }
    return 0;
  }
  const upper = code.toUpperCase();
  const rule = RULES[upper];
  if (!rule) {
    console.error(`Unknown rule code '${code}'. Available rules: ${Object.keys(RULES).join(", ")}`);
    return 1;
  }
  console.log(`# ${rule.code}: ${rule.title}\n`);
  console.log(`What it checks:\n  ${rule.summary}\n`);
  console.log(`How to fix:\n  ${rule.fix}`);
  return 0;
}
