import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const RULES = {
  HAR001: {
    code: "HAR001",
    title: "Missing core Harness directory or entry document",
    summary:
      "Ensures README.md, AGENTS.md, PROJECTS.md, CHANGELOG.md, docs/README.md, docs/architecture/overview.md, docs/reference/INDEX.md, and the five docs/ subdirectories exist.",
    fix: "Run `harness init` to create missing directories and baseline files.",
  },
  DIR001: {
    code: "DIR001",
    title: "Unauthorized file or directory in repository root or docs/",
    summary:
      "Enforces the directory allowlist for `docs/` (`README.md` + `architecture/`, `spec/`, `adr/`, `runbooks/`, `reference/`) and repository root (standard facade docs, engineering configs, and standard code/sandbox directories, extensible via `rootAllowlist` in `.agents/harness.json`). Blocks stray binary files (`.png`, `.jpg`, `.pdf`, `.zip`, etc.), temporary scripts, and non-standard `docs/` subdirectories.",
    fix: "Move or remove the unauthorized file/directory, or declare project-specific root entries under `rootAllowlist` in `.agents/harness.json`.",
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
    title: "Invalid test file naming or missing Test<Subject> hierarchy",
    summary:
      "Test files in `tests/` must be named by domain capability (`tests/test_<domain>.py` or `tests/<domain>.test.ts`, never `test_phase1.py` or `test1.test.ts`), group Python test functions inside `class Test<Subject>:` with `def test_<scenario>_<expected>()`, and group TypeScript/JavaScript tests inside `describe(\"Test<Subject>\", ...)` with `it(\"test_<scenario>_<expected>\", ...)`.",
    fix: "Rename the file by domain capability and group test cases inside `class Test<Subject>:` (`def test_<scenario>_<expected>()`) or `describe(\"Test<Subject>\", ...)` (`it(\"test_<scenario>_<expected>\", ...)`).",
  },
  TST002: {
    code: "TST002",
    title: "Forbidden mocking or monkeypatching of business logic in tests",
    summary:
      "Detects mocking frameworks and attribute monkeypatching (`unittest.mock`, `MagicMock`, `AsyncMock`, `@patch`, `mocker.patch`, `monkeypatch.setattr`, `jest.mock`, `vi.mock`, `sinon.stub`) in `tests/`. Environment variable overrides like `monkeypatch.setenv` / `monkeypatch.delenv` are allowed.",
    fix: "Replace mocks/stubs with real black-box fixtures or local test servers, or add `# harness-ignore TST002: <reason>` (or `// harness-ignore TST002: <reason>`) if justified.",
  },
  TST003: {
    code: "TST003",
    title: "Unauthorized modification or deletion of protected baseline/verifier path",
    summary:
      "Blocks edits or deletions to read-only verifier suites and baseline directories declared under `protectedPaths` in `.agents/harness.json`.",
    fix: "Revert changes to the protected path (`git checkout HEAD -- <path>`), or set `HARNESS_ALLOW_PROTECTED=1` when intentionally updating baselines.",
  },
  TST004: {
    code: "TST004",
    title: "Subprocess execution in tests missing explicit timeout guard",
    summary:
      "Scans `tests/` for `subprocess.run`, `spawnSync`, `execSync`, and `execFileSync` invocations without an explicit `timeout` parameter.",
    fix: "Pass an explicit `timeout` option (e.g., `timeout=10` in Python or `timeout: 10000` in JS/TS) to prevent hanging test runs.",
  },
  MTX001: {
    code: "MTX001",
    title: "Unauthorized modification of immutable column in protected matrix/CSV",
    summary:
      "Compares CSV/TSV files declared under `protectedMatrices` in `.agents/harness.json` against `HEAD` and blocks any modification or deletion of cells in `immutableColumns`.",
    fix: "Restore the immutable column values from `HEAD` (`git checkout HEAD -- <path>`).",
  },
  AST001: {
    code: "AST001",
    title: "Violation of declarative architecture layer dependency boundary",
    summary:
      "Enforces one-way import boundaries between architectural layers declared under `architecture.layers` in `.agents/harness.json`.",
    fix: "Remove the disallowed cross-layer import or invert the dependency to respect `allowImportsFrom` in `.agents/harness.json`.",
  },
  AST002: {
    code: "AST002",
    title: "Forbidden domain-specific literal or pattern in core module",
    summary:
      "Scans core module paths declared under `architecture.coreCleanliness` in `.agents/harness.json` for forbidden site-specific domains, IDs, or hardcoded patterns.",
    fix: "Extract the site/domain-specific literal into declarative configuration or adapter modules outside the core layer.",
  },
};

const IGNORED_WALK_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "teamwork",
  "work",
  "artifacts",
  "dist",
  "build",
  ".next",
  "target",
]);

const DEFAULT_DOCS_ALLOWED_DIRS = new Set([
  "architecture",
  "spec",
  "adr",
  "runbooks",
  "reference",
]);

const DEFAULT_DOCS_ALLOWED_FILES = new Set(["README.md", ".gitkeep", ".DS_Store"]);

const DEFAULT_ROOT_ALLOWED_FILES = new Set([
  "README.md",
  "PROJECTS.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "NOTICE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".gitkeep",
  ".DS_Store",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".tool-versions",
  ".env",
  ".env.example",
  ".env.local",
  ".env.test",
  ".env.development",
  ".env.production",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierignore",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintignore",
  ".ruff.toml",
  ".flake8",
  ".coveragerc",
  ".dockerignore",
  ".browserslistrc",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "tsconfig.json",
  "tsconfig.node.json",
  "tsconfig.app.json",
  "tsconfig.build.json",
  "jsconfig.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "prettier.config.js",
  "prettier.config.mjs",
  "prettier.config.cjs",
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vitest.config.js",
  "vitest.config.ts",
  "vitest.config.mjs",
  "jest.config.js",
  "jest.config.ts",
  "jest.config.mjs",
  "jest.config.cjs",
  "jest.config.json",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "svelte.config.js",
  "astro.config.mjs",
  "index.html",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "requirements.txt",
  "requirements-dev.txt",
  "setup.py",
  "setup.cfg",
  "MANIFEST.in",
  "tox.ini",
  "pytest.ini",
  "conftest.py",
  "pyrightconfig.json",
  "ruff.toml",
  "mypy.ini",
  "alembic.ini",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Makefile",
  "CMakeLists.txt",
  "Justfile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  "render.yaml",
]);

const DEFAULT_ROOT_ALLOWED_DIRS = new Set([
  ".git",
  ".github",
  ".agents",
  ".vscode",
  ".idea",
  ".husky",
  ".claude",
  ".cursor",
  ".gemini",
  ".venv",
  "venv",
  "node_modules",
  "bin",
  "src",
  "lib",
  "app",
  "pkg",
  "cmd",
  "internal",
  "crates",
  "packages",
  "apps",
  "services",
  "docs",
  "tests",
  "test",
  "__tests__",
  "e2e",
  "work",
  "artifacts",
  "experiments",
  "templates",
  "public",
  "static",
  "assets",
  "styles",
  "components",
  "pages",
  "scripts",
  "tools",
  "config",
  "configs",
  "migrations",
  "prisma",
  "drizzle",
  "supabase",
  "deploy",
  "infra",
  "docker",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
]);

export function loadHarnessConfig(targetRoot = process.cwd()) {
  const configPath = path.join(targetRoot, ".agents", "harness.json");
  try {
    if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  } catch {
    // Ignore malformed .agents/harness.json
  }
  return {};
}

export function matchGlob(relPath, pattern) {
  if (!relPath || !pattern) return false;
  const normPath = relPath.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
  const normPat = String(pattern).trim().split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
  if (!normPat) return false;

  if (!/[*?[\]]/.test(normPat)) {
    return normPath === normPat || normPath.startsWith(`${normPat}/`);
  }
  if (normPat.endsWith("/**")) {
    const prefix = normPat.slice(0, -3);
    if (normPath === prefix || normPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  let regexStr = "^";
  for (let i = 0; i < normPat.length; i++) {
    const ch = normPat[i];
    if (ch === "*") {
      if (normPat[i + 1] === "*") {
        if (normPat[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 2;
        } else {
          regexStr += ".*";
          i += 1;
        }
      } else {
        regexStr += "[^/]*";
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += "$";
  try {
    return new RegExp(regexStr).test(normPath);
  } catch {
    return false;
  }
}

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

function hasIgnoredSegment(relPath) {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  return segments.some((seg) => IGNORED_WALK_DIRS.has(seg));
}

function loadGitignorePatterns(targetRoot) {
  const gitignorePath = path.join(targetRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];
  try {
    return fs
      .readFileSync(gitignorePath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
  } catch {
    return [];
  }
}

function isIgnoredByGitignorePatterns(relPath, patterns) {
  const norm = relPath.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
  for (const rawPat of patterns) {
    const cleanPat = rawPat.replace(/^\/+|\/+$/g, "");
    if (!cleanPat) continue;
    if (
      norm === cleanPat ||
      norm.startsWith(`${cleanPat}/`) ||
      matchGlob(norm, cleanPat) ||
      matchGlob(path.basename(norm), cleanPat)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * PROP-11: Query Git for non-ignored tracked + untracked files (`git ls-files -co --exclude-standard`).
 * Returns `null` if `targetRoot` is not a Git working tree.
 */
function queryGitWorkspaceFiles(targetRoot) {
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    return null;
  }
  try {
    const proc = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "ls-files", "-co", "--exclude-standard", "-z"],
      {
        cwd: targetRoot,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 20 * 1024 * 1024,
      }
    );
    if (proc.status !== 0 || typeof proc.stdout !== "string") {
      return null;
    }
    const relFiles = [];
    for (const entry of proc.stdout.split("\0")) {
      if (!entry) continue;
      if (hasIgnoredSegment(entry)) continue;
      const abs = path.join(targetRoot, entry);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        relFiles.push(entry.split(path.sep).join("/"));
      }
    }
    return relFiles;
  } catch {
    return null;
  }
}

function isGitIgnored(targetRoot, relPath, gitignorePatterns) {
  if (hasIgnoredSegment(relPath)) return true;
  if (isIgnoredByGitignorePatterns(relPath, gitignorePatterns)) return true;
  if (fs.existsSync(path.join(targetRoot, ".git"))) {
    try {
      const proc = spawnSync("git", ["check-ignore", "-q", relPath], {
        cwd: targetRoot,
        timeout: 2000,
      });
      if (proc.status === 0) return true;
    } catch {
      // Fall through
    }
  }
  return false;
}

/**
 * Walk workspace to collect all non-ignored Markdown files (PROP-11).
 */
function collectMarkdownFiles(targetRoot, gitFiles = null, gitignorePatterns = []) {
  if (Array.isArray(gitFiles)) {
    return gitFiles
      .filter((rel) => rel.endsWith(".md"))
      .map((rel) => path.join(targetRoot, rel));
  }
  const results = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_WALK_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(targetRoot, fullPath).split(path.sep).join("/");
      if (isIgnoredByGitignorePatterns(relPath, gitignorePatterns)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  };
  walk(targetRoot);
  return results;
}

function parseCodeSuppressions(lines) {
  const suppressed = new Set();
  const invalidLines = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trim();
    const commentMatch = trimmed.match(/^(?:#|\/\/|\/\*+)\s*harness-ignore\b(.*)$/);
    if (commentMatch) {
      const rawBody = commentMatch[1].replace(/\*+\/\s*$/, "").trim();
      const parsed = rawBody.match(/^([A-Z]{3}\d{3})\s*:\s*(.+)$/);
      if (!parsed || !RULES[parsed[1]] || !parsed[2].trim()) {
        invalidLines.push(lineNum);
      } else {
        suppressed.add(parsed[1]);
      }
    }
  }
  return { suppressed, invalidLines };
}

function serializeDelimitedCell(val, delimiter = ",") {
  const str = String(val ?? "");
  if (str.includes(delimiter) || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Full RFC-4180 delimited table parser supporting quoted cells with embedded delimiters,
 * escaped double quotes (`""`), and embedded newlines (`\n` / `\r\n`) inside quotes.
 */
export function parseDelimitedTable(rawText, filePath = "") {
  const cleaned = rawText.replace(/^\uFEFF/, "");
  if (!cleaned.trim()) {
    return { delimiter: ",", headers: [], rows: [] };
  }

  // Detect delimiter from first physical line outside quotes
  let tabCount = 0;
  let commaCount = 0;
  let detectQuotes = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"') {
      if (detectQuotes && cleaned[i + 1] === '"') {
        i++;
      } else {
        detectQuotes = !detectQuotes;
      }
    } else if (!detectQuotes) {
      if (ch === "\t") tabCount++;
      else if (ch === ",") commaCount++;
      else if (ch === "\n" || ch === "\r") break;
    }
  }
  const delimiter =
    filePath.toLowerCase().endsWith(".tsv") || tabCount > commaCount ? "\t" : ",";

  const records = [];
  let cells = [];
  let cur = "";
  let inQuotes = false;
  let curLine = 1;
  let recordStartLine = 1;
  let recordStartIdx = 0;

  const pushRecord = (endIdx) => {
    const rawSlice = cleaned.slice(recordStartIdx, endIdx);
    if (rawSlice.trim() !== "") {
      records.push({
        lineNum: recordStartLine,
        raw: rawSlice,
        values: cells,
      });
    }
    cells = [];
    cur = "";
  };

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") curLine++;
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cur);
      cur = "";
    } else if (ch === "\r" || ch === "\n") {
      cells.push(cur);
      cur = "";
      pushRecord(i);
      if (ch === "\r" && cleaned[i + 1] === "\n") {
        i++;
      }
      curLine++;
      recordStartLine = curLine;
      recordStartIdx = i + 1;
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0 || cells.length > 0) {
    cells.push(cur);
    pushRecord(cleaned.length);
  }

  if (records.length === 0) {
    return { delimiter, headers: [], rows: [] };
  }

  const headers = records[0].values.map((h) => h.trim());
  const rows = records.slice(1);
  return { delimiter, headers, rows, headerRaw: records[0].raw };
}

/**
 * Align baseline rows from `headTable` with current rows in `curTable` so inserting or reordering rows
 * does not trigger false-positive `MTX001` diagnostics or overwrite newly inserted rows.
 */
function alignMatrixRows(headTable, curTable, immutableCols) {
  const validCols = [];
  for (const colName of immutableCols) {
    const headColIdx = headTable.headers.indexOf(colName);
    const curColIdx = curTable.headers.indexOf(colName);
    if (headColIdx !== -1 && curColIdx !== -1) {
      validCols.push({ colName, headColIdx, curColIdx });
    }
  }

  const headToCur = new Map();
  const curToHead = new Map();
  const usedCur = new Set();

  const matchesAllImmutable = (hRow, cRow) =>
    validCols.every(
      ({ headColIdx, curColIdx }) =>
        (hRow.values[headColIdx] ?? "").trim() === (cRow.values[curColIdx] ?? "").trim()
    );

  // Pass 1: Exact match across all immutable columns (prefer same index `hIdx` when tied)
  for (let hIdx = 0; hIdx < headTable.rows.length; hIdx++) {
    const hRow = headTable.rows[hIdx];
    if (
      hIdx < curTable.rows.length &&
      !usedCur.has(hIdx) &&
      matchesAllImmutable(hRow, curTable.rows[hIdx])
    ) {
      headToCur.set(hIdx, hIdx);
      curToHead.set(hIdx, hIdx);
      usedCur.add(hIdx);
      continue;
    }
    for (let cIdx = 0; cIdx < curTable.rows.length; cIdx++) {
      if (usedCur.has(cIdx)) continue;
      if (matchesAllImmutable(hRow, curTable.rows[cIdx])) {
        headToCur.set(hIdx, cIdx);
        curToHead.set(cIdx, hIdx);
        usedCur.add(cIdx);
        break;
      }
    }
  }

  // Pass 2: Match remaining baseline rows by primary key (col 0) or any unchanged immutable column
  const sameFirstHeader =
    headTable.headers.length > 0 &&
    curTable.headers.length > 0 &&
    headTable.headers[0] === curTable.headers[0];

  const matchesRowKey = (hRow, cRow) => {
    if (sameFirstHeader) {
      const hKey = (hRow.values[0] ?? "").trim();
      const cKey = (cRow.values[0] ?? "").trim();
      if (hKey && hKey === cKey) return true;
    }
    return validCols.some(({ headColIdx, curColIdx }) => {
      const hVal = (hRow.values[headColIdx] ?? "").trim();
      const cVal = (cRow.values[curColIdx] ?? "").trim();
      return hVal !== "" && hVal === cVal;
    });
  };

  for (let hIdx = 0; hIdx < headTable.rows.length; hIdx++) {
    if (headToCur.has(hIdx)) continue;
    const hRow = headTable.rows[hIdx];
    if (
      hIdx < curTable.rows.length &&
      !usedCur.has(hIdx) &&
      matchesRowKey(hRow, curTable.rows[hIdx])
    ) {
      headToCur.set(hIdx, hIdx);
      curToHead.set(hIdx, hIdx);
      usedCur.add(hIdx);
      continue;
    }
    for (let cIdx = 0; cIdx < curTable.rows.length; cIdx++) {
      if (usedCur.has(cIdx)) continue;
      if (matchesRowKey(hRow, curTable.rows[cIdx])) {
        headToCur.set(hIdx, cIdx);
        curToHead.set(cIdx, hIdx);
        usedCur.add(cIdx);
        break;
      }
    }
  }

  // Pass 3: Positional fallback for any still-unmatched baseline rows
  for (let hIdx = 0; hIdx < headTable.rows.length; hIdx++) {
    if (headToCur.has(hIdx)) continue;
    if (hIdx < curTable.rows.length && !usedCur.has(hIdx)) {
      headToCur.set(hIdx, hIdx);
      curToHead.set(hIdx, hIdx);
      usedCur.add(hIdx);
      continue;
    }
    for (let cIdx = 0; cIdx < curTable.rows.length; cIdx++) {
      if (!usedCur.has(cIdx)) {
        headToCur.set(hIdx, cIdx);
        curToHead.set(cIdx, hIdx);
        usedCur.add(cIdx);
        break;
      }
    }
  }

  return { headToCur, curToHead };
}

/**
 * PROP-02: Automatically restore tampered immutable columns in protected matrices from HEAD.
 * Used by `harness hook run` so tampered baseline URLs/IDs are reverted on disk while warning the agent.
 */
export function restoreProtectedMatrices(targetRoot = process.cwd()) {
  if (
    process.env.HARNESS_ALLOW_PROTECTED === "1" ||
    process.env.HARNESS_ALLOW_PROTECTED_MATRICES === "1"
  ) {
    return { restoredFiles: [] };
  }
  const harnessConfig = loadHarnessConfig(targetRoot);
  const matrices = Array.isArray(harnessConfig.protectedMatrices)
    ? harnessConfig.protectedMatrices
    : [];
  const restoredFiles = [];

  if (matrices.length === 0 || !fs.existsSync(path.join(targetRoot, ".git"))) {
    return { restoredFiles };
  }

  for (const matrixSpec of matrices) {
    const relPath = String(matrixSpec?.path || "").trim();
    const immutableCols = Array.isArray(matrixSpec?.immutableColumns)
      ? matrixSpec.immutableColumns.map((c) => String(c).trim()).filter(Boolean)
      : [];
    if (!relPath || immutableCols.length === 0) continue;

    const headRes = spawnSync("git", ["show", `HEAD:${relPath}`], {
      cwd: targetRoot,
      encoding: "utf8",
      timeout: 5000,
    });
    if (headRes.status !== 0 || typeof headRes.stdout !== "string") continue;

    const absPath = path.join(targetRoot, relPath);
    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, headRes.stdout, "utf8");
      restoredFiles.push(relPath);
      continue;
    }

    const headTable = parseDelimitedTable(headRes.stdout, relPath);
    const curText = fs.readFileSync(absPath, "utf8");
    const curTable = parseDelimitedTable(curText, relPath);

    const missingCol = immutableCols.some(
      (col) => headTable.headers.includes(col) && !curTable.headers.includes(col)
    );
    if (missingCol || curTable.rows.length < headTable.rows.length) {
      fs.writeFileSync(absPath, headRes.stdout, "utf8");
      restoredFiles.push(relPath);
      continue;
    }

    const { curToHead } = alignMatrixRows(headTable, curTable, immutableCols);
    let modified = false;
    const serializedRecords = [
      curTable.headerRaw ||
        curTable.headers.map((h) => serializeDelimitedCell(h, curTable.delimiter)).join(curTable.delimiter),
    ];

    for (let r = 0; r < curTable.rows.length; r++) {
      const curRow = curTable.rows[r];
      const matchedHeadIdx = curToHead.get(r);
      const headRow = matchedHeadIdx !== undefined ? headTable.rows[matchedHeadIdx] : null;
      if (!headRow) {
        serializedRecords.push(curRow.raw);
        continue;
      }
      const updatedValues = [...curRow.values];
      let rowChanged = false;
      for (const colName of immutableCols) {
        const headColIdx = headTable.headers.indexOf(colName);
        const curColIdx = curTable.headers.indexOf(colName);
        if (headColIdx === -1 || curColIdx === -1) continue;
        const headVal = (headRow.values[headColIdx] ?? "").trim();
        const curVal = (curRow.values[curColIdx] ?? "").trim();
        if (headVal !== curVal) {
          while (updatedValues.length <= curColIdx) {
            updatedValues.push("");
          }
          updatedValues[curColIdx] = headRow.values[headColIdx] ?? "";
          rowChanged = true;
          modified = true;
        }
      }
      if (rowChanged) {
        serializedRecords.push(
          updatedValues
            .map((v) => serializeDelimitedCell(v, curTable.delimiter))
            .join(curTable.delimiter)
        );
      } else {
        serializedRecords.push(curRow.raw);
      }
    }

    if (modified) {
      fs.writeFileSync(absPath, `${serializedRecords.join("\n")}\n`, "utf8");
      restoredFiles.push(relPath);
    }
  }

  return { restoredFiles };
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

  const harnessConfig = loadHarnessConfig(targetRoot);
  const gitignorePatterns = loadGitignorePatterns(targetRoot);
  const gitWorkspaceFiles = queryGitWorkspaceFiles(targetRoot);
  const gitWorkspaceSet = Array.isArray(gitWorkspaceFiles) ? new Set(gitWorkspaceFiles) : null;

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

  // 1b. DIR001 (PROP-09): Repository root & docs/ allowlist guard
  const sharedRootEntries = Array.isArray(harnessConfig.worktreeSharedPaths)
    ? harnessConfig.worktreeSharedPaths
        .map((s) => String(s).trim().replace(/^\/+|\/+$/g, "").split("/")[0])
        .filter(Boolean)
    : [];
  const customRootAllowlist = [
    ...(Array.isArray(harnessConfig.rootAllowlist)
      ? harnessConfig.rootAllowlist.map((s) => String(s).trim().replace(/\/+$/, "")).filter(Boolean)
      : []),
    ...sharedRootEntries,
  ];

  const isCustomAllowed = (name, allowlist) =>
    allowlist.some((pat) => pat === name || matchGlob(name, pat));

  const docsDir = path.join(targetRoot, "docs");
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name === ".gitkeep") continue;
      const relEntry = `docs/${entry.name}`;
      if (isGitIgnored(targetRoot, relEntry, gitignorePatterns)) continue;

      if (entry.isDirectory()) {
        if (!DEFAULT_DOCS_ALLOWED_DIRS.has(entry.name)) {
          addDiag(
            "DIR001",
            relEntry,
            1,
            `Unauthorized directory '${relEntry}/' inside 'docs/'; only the 5 standard subdirectories ('architecture/', 'spec/', 'adr/', 'runbooks/', 'reference/') are allowed.`,
            `Move research/reference documents into 'docs/reference/' (and register in 'docs/reference/INDEX.md') or remove '${relEntry}/'.`
          );
        }
      } else if (!DEFAULT_DOCS_ALLOWED_FILES.has(entry.name)) {
        addDiag(
          "DIR001",
          relEntry,
          1,
          `Unauthorized top-level file '${relEntry}' inside 'docs/'; only 'docs/README.md' is allowed directly under 'docs/'.`,
          `Move '${relEntry}' into the appropriate 'docs/' subdirectory ('architecture/', 'spec/issue#<N>/', 'adr/', 'runbooks/', or 'reference/').`
        );
      }
    }
  }

  for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === ".gitkeep") continue;
    if (isGitIgnored(targetRoot, entry.name, gitignorePatterns)) continue;
    if (isCustomAllowed(entry.name, customRootAllowlist)) continue;

    if (entry.isDirectory()) {
      if (!DEFAULT_ROOT_ALLOWED_DIRS.has(entry.name)) {
        addDiag(
          "DIR001",
          entry.name,
          1,
          `Unauthorized root directory '${entry.name}/'; repository root must remain clean.`,
          `Move '${entry.name}/' into 'src/', 'work/', or 'experiments/', or add "${entry.name}" to 'rootAllowlist' in '.agents/harness.json'.`
        );
      }
    } else if (!DEFAULT_ROOT_ALLOWED_FILES.has(entry.name)) {
      addDiag(
        "DIR001",
        entry.name,
        1,
        `Unauthorized file '${entry.name}' in repository root; stray binary assets, screenshots, or ad-hoc scripts are not allowed in root.`,
        `Move '${entry.name}' to 'docs/reference/' or 'work/', or add "${entry.name}" to 'rootAllowlist' in '.agents/harness.json'.`
      );
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
        const relToRoot = path.relative(targetRoot, abs).split(path.sep).join("/");
        if (gitWorkspaceSet ? !entry.isDirectory() && !gitWorkspaceSet.has(relToRoot) : isGitIgnored(targetRoot, relToRoot, gitignorePatterns)) {
          continue;
        }
        if (entry.isDirectory()) {
          if (isGitIgnored(targetRoot, relToRoot, gitignorePatterns)) continue;
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
  const mdFiles = collectMarkdownFiles(targetRoot, gitWorkspaceFiles, gitignorePatterns);
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

  // 8. TST001, TST002, TST004, and SUP001 in tests/
  const testsDir = path.join(targetRoot, "tests");
  if (fs.existsSync(testsDir) && fs.statSync(testsDir).isDirectory()) {
    const ignoredTestSubdirs = new Set([
      "__pycache__",
      ".pytest_cache",
      "fixtures",
      "node_modules",
    ]);
    const testCodeFiles = [];
    if (Array.isArray(gitWorkspaceFiles)) {
      for (const rel of gitWorkspaceFiles) {
        if (!rel.startsWith("tests/")) continue;
        const subSegments = rel.slice("tests/".length).split("/");
        if (subSegments.slice(0, -1).some((s) => ignoredTestSubdirs.has(s))) continue;
        if (/\.(?:py|js|jsx|mjs|cjs|ts|tsx)$/i.test(rel)) {
          testCodeFiles.push(path.join(targetRoot, rel));
        }
      }
    } else {
      const walkTests = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === ".gitkeep" || entry.name === ".DS_Store") continue;
          const abs = path.join(dir, entry.name);
          const rel = path.relative(targetRoot, abs).split(path.sep).join("/");
          if (isGitIgnored(targetRoot, rel, gitignorePatterns)) continue;
          if (entry.isDirectory()) {
            if (ignoredTestSubdirs.has(entry.name)) continue;
            walkTests(abs);
          } else if (
            entry.isFile() &&
            /\.(?:py|js|jsx|mjs|cjs|ts|tsx)$/i.test(entry.name)
          ) {
            testCodeFiles.push(abs);
          }
        }
      };
      walkTests(testsDir);
    }

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
      const isJsTsTestFile = /\.(?:test|spec)\.(?:[jt]sx?|[mc]?js)$/i.test(baseName);
      const content = fs.readFileSync(testAbs, "utf8");
      const lines = content.split(/\r?\n/);

      // Scan code comment suppressions: # harness-ignore CODE: reason or // harness-ignore CODE: reason
      const { suppressed: suppressedTestRules, invalidLines } = parseCodeSuppressions(lines);
      for (const lineNum of invalidLines) {
        addDiag(
          "SUP001",
          relFile,
          lineNum,
          "Invalid `harness-ignore` comment in test file; must specify a valid rule code and reason (`# harness-ignore CODE: reason`)."
        );
      }

      // TST001: File naming & Python / TypeScript / JavaScript hierarchy (PROP-05)
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
          /^\d+[_.-]/i.test(baseName) ||
          /(?:^|[._-])(?:phase|step|stage|part|iter|sprint)[_-]?\d+\.(?:test|spec)\.(?:[jt]sx?|[mc]?js)$/i.test(
            baseName
          ) ||
          /^test[_-]?\d+\.(?:test|spec)\.(?:[jt]sx?|[mc]?js)$/i.test(baseName);

        if (isPhaseOrNumberNamed) {
          addDiag(
            "TST001",
            relFile,
            1,
            `Test file '${baseName}' uses phase/step/sequence naming; name test files by domain capability (e.g., 'tests/test_<domain>.py' or 'tests/<domain>.test.ts').`
          );
        } else if (isPyTestFile && !/^test_[a-z][a-z0-9_]*\.py$/.test(baseName)) {
          addDiag(
            "TST001",
            relFile,
            1,
            `Python test file '${baseName}' must match 'tests/test_<domain>.py' domain naming convention.`
          );
        } else if (
          isJsTsTestFile &&
          !/^(?:test_)?[a-z][a-z0-9_-]*\.(?:test|spec)\.(?:[jt]sx?|[mc]?js)$/.test(baseName)
        ) {
          addDiag(
            "TST001",
            relFile,
            1,
            `TypeScript/JavaScript test file '${baseName}' must match 'tests/<domain>.test.ts' domain naming convention.`
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
        } else if (isJsTsTestFile) {
          const fullyMasked = maskCodeStringsAndComments(content, false);
          const describeMatches = [];
          const testCaseMatches = [];

          const descRegex =
            /(?<![.\w$])(describe(?:\s*\.\s*(?:only|skip|concurrent|sequential|shuffle|each\s*\([^)]*\)))*\s*\(\s*)(['"`])([ \t]*)\2\s*,/g;
          let dm;
          while ((dm = descRegex.exec(fullyMasked)) !== null) {
            const before = fullyMasked.slice(0, dm.index).trimEnd();
            if (before.endsWith(".") || /\bfunction$/.test(before)) continue;
            const titleStart = dm.index + dm[1].length + 1;
            const titleEnd = titleStart + dm[3].length;
            const title = content.slice(titleStart, titleEnd);
            const lineStart = fullyMasked.lastIndexOf("\n", dm.index) + 1;
            const prefix = fullyMasked.slice(lineStart, dm.index);
            const indent = /^\s*$/.test(prefix) ? prefix.length : Math.max(1, prefix.length);
            const lineNum = fullyMasked.slice(0, dm.index).split("\n").length;
            describeMatches.push({
              lineNum,
              indent,
              title,
            });
          }

          const itRegex =
            /(?<![.\w$])((?:it|test)((?:\s*\.\s*(?:only|skip|concurrent|sequential|todo|fails|each\s*\([^)]*\)))*)\s*\(\s*)(['"`])([ \t]*)\3\s*(,|\))/g;
          let im;
          while ((im = itRegex.exec(fullyMasked)) !== null) {
            const before = fullyMasked.slice(0, im.index).trimEnd();
            if (before.endsWith(".") || /\bfunction$/.test(before)) continue;
            const modifiers = im[2] || "";
            const trailingToken = im[5];
            if (trailingToken === ")" && !/\.\s*todo\b/.test(modifiers)) continue;
            const titleStart = im.index + im[1].length + 1;
            const titleEnd = titleStart + im[4].length;
            const title = content.slice(titleStart, titleEnd);
            const lineStart = fullyMasked.lastIndexOf("\n", im.index) + 1;
            const prefix = fullyMasked.slice(lineStart, im.index);
            const indent = /^\s*$/.test(prefix) ? prefix.length : Math.max(1, prefix.length);
            const lineNum = fullyMasked.slice(0, im.index).split("\n").length;
            testCaseMatches.push({
              lineNum,
              indent,
              title,
            });
          }

          const topLevelDescribes = describeMatches.filter((d) => d.indent === 0);
          const targetDescribes =
            topLevelDescribes.length > 0 ? topLevelDescribes : describeMatches;

          if (targetDescribes.length === 0) {
            if (!isPhaseOrNumberNamed) {
              addDiag(
                "TST001",
                relFile,
                testCaseMatches[0]?.lineNum || 1,
                `TypeScript/JavaScript test suite in '${baseName}' must be grouped inside a 'describe("Test<Subject>", ...)' hierarchy.`
              );
            }
          } else {
            for (const d of targetDescribes) {
              if (!/^Test[A-Z0-9][A-Za-z0-9_]*$/.test(d.title)) {
                addDiag(
                  "TST001",
                  relFile,
                  d.lineNum,
                  `TypeScript/JavaScript test suite '${d.title}' in '${baseName}' must be grouped inside a 'describe("Test<Subject>", ...)' hierarchy.`
                );
              }
            }
          }

          if (testCaseMatches.length === 0 && !isPhaseOrNumberNamed) {
            addDiag(
              "TST001",
              relFile,
              describeMatches[0]?.lineNum || 1,
              `TypeScript/JavaScript test suite in '${baseName}' must contain at least one 'it("test_<scenario>_<expected>", ...)' test case.`
            );
          }

          for (const tc of testCaseMatches) {
            if (describeMatches.length === 0 || tc.indent === 0) {
              addDiag(
                "TST001",
                relFile,
                tc.lineNum,
                `Top-level test case '${tc.title}' must be nested inside a 'describe("Test<Subject>", ...)' block.`
              );
            }
            if (!/^test_[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(tc.title)) {
              addDiag(
                "TST001",
                relFile,
                tc.lineNum,
                `Test case '${tc.title}' must follow 'it("test_<scenario>_<expected>", ...)' naming covering both scenario and expected outcome.`
              );
            }
          }
        }
      }

      // TST002: Forbidden mocking or business attribute monkeypatching
      if (!suppressedTestRules.has("TST002")) {
        const fullyMaskedLines = maskCodeStringsAndComments(content, isPy).split(/\r?\n/);
        for (let i = 0; i < fullyMaskedLines.length; i++) {
          const lineNum = i + 1;
          const rawLine = fullyMaskedLines[i];
          if (!rawLine.trim()) continue;
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

      // TST004 (PROP-12): Test subprocess calls must pass an explicit `timeout` option
      if (!suppressedTestRules.has("TST004")) {
        const maskedCode = maskCodeStringsAndComments(content, isPy);
        const callRegex = /\b(subprocess\.run|spawnSync|execSync|execFileSync)\s*\(/g;
        let cm;
        while ((cm = callRegex.exec(maskedCode)) !== null) {
          const fnLabel = cm[1];
          const openParenIdx = cm.index + cm[0].length - 1;
          const lineNum = maskedCode.slice(0, cm.index).split("\n").length;

          let depth = 0;
          let endIdx = maskedCode.length;
          for (let k = openParenIdx; k < maskedCode.length; k++) {
            const ch = maskedCode[k];
            if (ch === "(") depth++;
            else if (ch === ")") {
              depth--;
              if (depth === 0) {
                endIdx = k + 1;
                break;
              }
            }
          }

          const maskedCallArgs = maskedCode.slice(openParenIdx, endIdx);
          const hasTimeout =
            fnLabel === "subprocess.run"
              ? /\btimeout\s*=/.test(maskedCallArgs)
              : /\btimeout\s*[:,}]/.test(maskedCallArgs);

          if (!hasTimeout) {
            addDiag(
              "TST004",
              relFile,
              lineNum,
              `Subprocess call '${fnLabel}(...)' in '${relFile}' is missing an explicit 'timeout' parameter.`
            );
          }
        }
      }
    }
  }

  // 9. TST003 (PROP-01): Protected read-only verifier/baseline paths lock
  const protectedPaths = Array.isArray(harnessConfig.protectedPaths)
    ? harnessConfig.protectedPaths.map((p) => String(p).trim()).filter(Boolean)
    : [];
  if (
    protectedPaths.length > 0 &&
    process.env.HARNESS_ALLOW_PROTECTED !== "1" &&
    process.env.HARNESS_ALLOW_PROTECTED_PATHS !== "1" &&
    fs.existsSync(path.join(targetRoot, ".git"))
  ) {
    const changedSet = new Set();
    const diffHead = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", "HEAD", "-z"],
      { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
    );
    if (diffHead.status === 0 && diffHead.stdout) {
      for (const f of diffHead.stdout.split("\0")) {
        if (f) changedSet.add(f.split(path.sep).join("/"));
      }
    }
    const diffWorktree = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", "-z"],
      { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
    );
    if (diffWorktree.status === 0 && diffWorktree.stdout) {
      for (const f of diffWorktree.stdout.split("\0")) {
        if (f) changedSet.add(f.split(path.sep).join("/"));
      }
    }
    const diffCached = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "-z"],
      { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
    );
    if (diffCached.status === 0 && diffCached.stdout) {
      for (const f of diffCached.stdout.split("\0")) {
        if (f) changedSet.add(f.split(path.sep).join("/"));
      }
    }
    const untracked = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
    );
    if (untracked.status === 0 && untracked.stdout) {
      for (const f of untracked.stdout.split("\0")) {
        if (f) changedSet.add(f.split(path.sep).join("/"));
      }
    }

    for (const changedFile of changedSet) {
      const matchedPattern = protectedPaths.find((pat) => matchGlob(changedFile, pat));
      if (!matchedPattern) continue;

      addDiag(
        "TST003",
        changedFile,
        1,
        `Protected verifier/baseline file '${changedFile}' (matching '${matchedPattern}') was modified or deleted.`
      );
    }
  }

  // 10. MTX001 (PROP-02): Protected matrix/CSV immutable column lock
  const protectedMatrices = Array.isArray(harnessConfig.protectedMatrices)
    ? harnessConfig.protectedMatrices
    : [];
  if (
    protectedMatrices.length > 0 &&
    process.env.HARNESS_ALLOW_PROTECTED !== "1" &&
    process.env.HARNESS_ALLOW_PROTECTED_MATRICES !== "1" &&
    fs.existsSync(path.join(targetRoot, ".git"))
  ) {
    for (const matrixSpec of protectedMatrices) {
      const relPath = String(matrixSpec?.path || "").trim();
      const immutableCols = Array.isArray(matrixSpec?.immutableColumns)
        ? matrixSpec.immutableColumns.map((c) => String(c).trim()).filter(Boolean)
        : [];
      if (!relPath || immutableCols.length === 0) continue;

      const headRes = spawnSync("git", ["show", `HEAD:${relPath}`], {
        cwd: targetRoot,
        encoding: "utf8",
        timeout: 5000,
      });
      if (headRes.status !== 0 || typeof headRes.stdout !== "string") continue;

      const absPath = path.join(targetRoot, relPath);
      if (!fs.existsSync(absPath)) {
        addDiag(
          "MTX001",
          relPath,
          1,
          `Protected matrix file '${relPath}' was deleted.`
        );
        continue;
      }

      const headTable = parseDelimitedTable(headRes.stdout, relPath);
      const curTable = parseDelimitedTable(fs.readFileSync(absPath, "utf8"), relPath);
      const { headToCur } = alignMatrixRows(headTable, curTable, immutableCols);

      for (const colName of immutableCols) {
        const headColIdx = headTable.headers.indexOf(colName);
        if (headColIdx === -1) continue;
        const curColIdx = curTable.headers.indexOf(colName);
        if (curColIdx === -1) {
          addDiag(
            "MTX001",
            relPath,
            1,
            `Immutable column '${colName}' was removed or renamed in protected matrix '${relPath}'.`
          );
          continue;
        }

        if (curTable.rows.length < headTable.rows.length) {
          addDiag(
            "MTX001",
            relPath,
            1,
            `Protected matrix '${relPath}' had baseline row(s) deleted (${headTable.rows.length} -> ${curTable.rows.length}).`
          );
          break;
        }

        for (let r = 0; r < headTable.rows.length; r++) {
          const headVal = (headTable.rows[r].values[headColIdx] ?? "").trim();
          const curIdx = headToCur.get(r) ?? r;
          const curRow = curTable.rows[curIdx];
          const curVal = (curRow?.values[curColIdx] ?? "").trim();
          if (headVal !== curVal) {
            addDiag(
              "MTX001",
              relPath,
              curRow?.lineNum || curIdx + 2,
              `Immutable column '${colName}' at row ${curIdx + 1} in '${relPath}' was modified ('${headVal}' -> '${curVal}').`
            );
          }
        }
      }
    }
  }

  // 11. AST001 & AST002 (PROP-12): Declarative architecture layer boundaries & core cleanliness
  const archConfig =
    harnessConfig.architecture && typeof harnessConfig.architecture === "object"
      ? harnessConfig.architecture
      : {};
  const layers = Array.isArray(archConfig.layers) ? archConfig.layers : [];
  const coreCleanliness = Array.isArray(archConfig.coreCleanliness)
    ? archConfig.coreCleanliness
    : [];

  const collectSourceFilesInDir = (rawRelDir) => {
    const cleanRel = String(rawRelDir || "")
      .trim()
      .split(path.sep)
      .join("/")
      .replace(/\/\*\*$/, "")
      .replace(/\/\*$/, "")
      .replace(/^\/+|\/+$/g, "");
    if (!cleanRel) return [];

    if (Array.isArray(gitWorkspaceFiles)) {
      return gitWorkspaceFiles
        .filter(
          (rel) =>
            (rel === cleanRel ||
              rel.startsWith(`${cleanRel}/`) ||
              matchGlob(rel, rawRelDir)) &&
            /\.(?:py|js|jsx|mjs|cjs|ts|tsx)$/i.test(rel)
        )
        .map((rel) => path.join(targetRoot, rel));
    }

    const absDir = path.join(targetRoot, cleanRel);
    if (!fs.existsSync(absDir)) return [];
    if (fs.statSync(absDir).isFile()) return [absDir];
    const files = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (IGNORED_WALK_DIRS.has(entry.name) || entry.name === ".DS_Store") continue;
        const full = path.join(d, entry.name);
        const rel = path.relative(targetRoot, full).split(path.sep).join("/");
        if (isGitIgnored(targetRoot, rel, gitignorePatterns)) continue;
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.isFile() &&
          /\.(?:py|js|jsx|mjs|cjs|ts|tsx)$/i.test(entry.name)
        ) {
          files.push(full);
        }
      }
    };
    walk(absDir);
    return files;
  };

  if (layers.length > 0) {
    const normalizedLayers = layers
      .map((l) => {
        const name = String(l?.name || "").trim();
        const relPath = String(l?.path || "")
          .trim()
          .split(path.sep)
          .join("/")
          .replace(/\/\*\*$/, "")
          .replace(/\/\*$/, "")
          .replace(/^\/+|\/+$/g, "");
        const allowImportsFrom = new Set(
          Array.isArray(l?.allowImportsFrom)
            ? l.allowImportsFrom.map((a) => String(a).trim()).filter(Boolean)
            : []
        );
        const dottedFull = relPath.replace(/\//g, ".");
        const dottedWithoutSrc = relPath.replace(/^src\//, "").replace(/\//g, ".");
        return { name, relPath, allowImportsFrom, dottedFull, dottedWithoutSrc };
      })
      .filter((l) => l.name && l.relPath);

    for (const layer of normalizedLayers) {
      const files = collectSourceFilesInDir(layer.relPath);
      for (const fileAbs of files) {
        const relFile = path.relative(targetRoot, fileAbs).split(path.sep).join("/");
        const content = fs.readFileSync(fileAbs, "utf8");
        const lines = content.split(/\r?\n/);
        const { suppressed } = parseCodeSuppressions(lines);
        if (suppressed.has("AST001")) continue;

        const isPy = relFile.endsWith(".py");
        const extractedImports = extractModuleImports(content, isPy);

        for (const imp of extractedImports) {
          for (const other of normalizedLayers) {
            if (other.name === layer.name) continue;
            let hitsOther = false;
            if (imp.type === "py") {
              if (imp.spec.startsWith(".")) {
                let dots = 0;
                while (imp.spec[dots] === ".") dots++;
                const tail = imp.spec.slice(dots).replace(/\./g, "/");
                let baseDir = path.dirname(fileAbs);
                for (let d = 1; d < dots; d++) {
                  baseDir = path.dirname(baseDir);
                }
                const resolvedRel = path
                  .relative(targetRoot, tail ? path.join(baseDir, tail) : baseDir)
                  .split(path.sep)
                  .join("/");
                if (
                  resolvedRel === other.relPath ||
                  resolvedRel.startsWith(`${other.relPath}/`)
                ) {
                  hitsOther = true;
                }
              } else if (
                imp.spec === other.dottedWithoutSrc ||
                imp.spec.startsWith(`${other.dottedWithoutSrc}.`) ||
                imp.spec === other.dottedFull ||
                imp.spec.startsWith(`${other.dottedFull}.`)
              ) {
                hitsOther = true;
              }
            } else {
              let resolvedRel = "";
              if (imp.spec.startsWith(".")) {
                resolvedRel = path
                  .relative(targetRoot, path.resolve(path.dirname(fileAbs), imp.spec))
                  .split(path.sep)
                  .join("/");
              } else if (imp.spec.startsWith("@/")) {
                resolvedRel = `src/${imp.spec.slice(2)}`;
              } else {
                resolvedRel = imp.spec;
              }
              const strippedExt = resolvedRel.replace(/\.(?:[jt]sx?|[mc]?js|py)$/i, "");
              if (
                resolvedRel === other.relPath ||
                resolvedRel.startsWith(`${other.relPath}/`) ||
                strippedExt === other.relPath ||
                strippedExt.startsWith(`${other.relPath}/`)
              ) {
                hitsOther = true;
              }
            }

            if (
              hitsOther &&
              !layer.allowImportsFrom.has(other.name) &&
              !layer.allowImportsFrom.has(other.relPath)
            ) {
              addDiag(
                "AST001",
                relFile,
                imp.lineNum,
                `Layer '${layer.name}' ('${relFile}') is not allowed to import from layer '${other.name}' ('${imp.displaySpec || imp.spec}').`
              );
            }
          }
        }
      }
    }
  }

  if (coreCleanliness.length > 0) {
    for (const ruleEntry of coreCleanliness) {
      const pathsList = Array.isArray(ruleEntry?.paths) ? ruleEntry.paths : [];
      const rawPatterns = Array.isArray(ruleEntry?.forbiddenPatterns)
        ? ruleEntry.forbiddenPatterns
        : [];
      const compiledPatterns = [];
      for (const rawPat of rawPatterns) {
        try {
          compiledPatterns.push({ raw: rawPat, regex: new RegExp(rawPat) });
        } catch {
          // Ignore invalid regex in config
        }
      }
      if (compiledPatterns.length === 0) continue;

      for (const relDir of pathsList) {
        const files = collectSourceFilesInDir(String(relDir).trim());
        for (const fileAbs of files) {
          const relFile = path.relative(targetRoot, fileAbs).split(path.sep).join("/");
          const content = fs.readFileSync(fileAbs, "utf8");
          const lines = content.split(/\r?\n/);
          const { suppressed } = parseCodeSuppressions(lines);
          if (suppressed.has("AST002")) continue;

          const commentMaskedLines = maskCodeComments(content, relFile.endsWith(".py")).split(
            /\r?\n/
          );
          for (let i = 0; i < commentMaskedLines.length; i++) {
            const lineNum = i + 1;
            const maskedLine = commentMaskedLines[i];
            if (!maskedLine.trim()) continue;
            for (const pat of compiledPatterns) {
              const m = maskedLine.match(pat.regex);
              if (m) {
                addDiag(
                  "AST002",
                  relFile,
                  lineNum,
                  `Forbidden domain-specific pattern '${m[0]}' (matching /${pat.raw}/) detected in core module '${relFile}'.`
                );
                break;
              }
            }
          }
        }
      }
    }
  }

  return diagnostics;
}

const JS_REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "yield",
  "await",
  "else",
  "do",
]);

const JS_REGEX_PRECEDING_PUNCTUATORS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "~",
  "^",
  "%",
  "+",
  "-",
  "*",
  "<",
  ">",
]);

/**
 * If `slashIdx` in JS/TS `content` starts a regex literal `/.../flags`,
 * returns `{ closeSlashIdx, endIdx }`; otherwise returns `null`.
 */
function findJsRegexLiteral(content, out, slashIdx) {
  const len = content.length;
  if (
    slashIdx + 1 >= len ||
    content[slashIdx + 1] === "/" ||
    content[slashIdx + 1] === "*" ||
    content[slashIdx + 1] === "\n" ||
    content[slashIdx + 1] === "\r"
  ) {
    return null;
  }

  let p = out.length - 1;
  while (p >= 0 && (out[p] === " " || out[p] === "\t" || out[p] === "\n" || out[p] === "\r")) {
    p--;
  }
  let canPrecede = false;
  if (p < 0) {
    canPrecede = true;
  } else {
    const prevCh = out[p];
    if (JS_REGEX_PRECEDING_PUNCTUATORS.has(prevCh)) {
      if ((prevCh === "+" && out[p - 1] === "+") || (prevCh === "-" && out[p - 1] === "-")) {
        canPrecede = false;
      } else {
        canPrecede = true;
      }
    } else if (/[A-Za-z0-9_$]/.test(prevCh)) {
      let wordStart = p;
      while (wordStart > 0 && /[A-Za-z0-9_$]/.test(out[wordStart - 1])) {
        wordStart--;
      }
      const word = content.slice(wordStart, p + 1);
      if (JS_REGEX_PRECEDING_KEYWORDS.has(word)) {
        canPrecede = true;
      }
    }
  }
  if (!canPrecede) return null;

  let j = slashIdx + 1;
  let inCharClass = false;
  while (j < len) {
    const c = content[j];
    if (c === "\n" || c === "\r") {
      return null;
    }
    if (c === "\\") {
      if (j + 1 >= len || content[j + 1] === "\n" || content[j + 1] === "\r") {
        return null;
      }
      j += 2;
      continue;
    }
    if (c === "[") {
      inCharClass = true;
    } else if (c === "]") {
      inCharClass = false;
    } else if (c === "/" && !inCharClass) {
      const closeSlashIdx = j;
      let endIdx = j + 1;
      while (endIdx < len && /[dgimsuvy]/.test(content[endIdx])) {
        endIdx++;
      }
      return { closeSlashIdx, endIdx };
    }
    j++;
  }
  return null;
}

/**
 * Replace code comments (`# ...` in Python, `// ...` and `/* ... * /` in JS/TS) with spaces
 * while preserving string literals, regex literals, and exact line/character offsets.
 */
function maskCodeComments(content, isPy = false) {
  const out = [];
  let i = 0;
  const len = content.length;
  while (i < len) {
    const ch = content[i];
    if (isPy && (ch === '"' || ch === "'")) {
      const triple = content.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        out.push(triple);
        i += 3;
        while (i < len && content.slice(i, i + 3) !== triple) {
          if (content[i] === "\\" && i + 1 < len) {
            out.push(content[i], content[i + 1]);
            i += 2;
          } else {
            out.push(content[i]);
            i++;
          }
        }
        if (i < len) {
          out.push(triple);
          i += 3;
        }
        continue;
      }
    }
    if (ch === '"' || ch === "'" || (!isPy && ch === "`")) {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < len && content[i] !== quote) {
        if (content[i] === "\\" && i + 1 < len) {
          out.push(content[i], content[i + 1]);
          i += 2;
        } else {
          if (quote !== "`" && (content[i] === "\n" || content[i] === "\r")) {
            break;
          }
          out.push(content[i]);
          i++;
        }
      }
      if (i < len && content[i] === quote) {
        out.push(content[i]);
        i++;
      }
      continue;
    }
    if (isPy && ch === "#") {
      while (i < len && content[i] !== "\n" && content[i] !== "\r") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (!isPy && ch === "/" && content[i + 1] === "/") {
      while (i < len && content[i] !== "\n" && content[i] !== "\r") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (!isPy && ch === "/" && content[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < len && !(content[i] === "*" && content[i + 1] === "/")) {
        out.push(content[i] === "\n" || content[i] === "\r" ? content[i] : " ");
        i++;
      }
      if (i < len) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (!isPy && ch === "/") {
      const rx = findJsRegexLiteral(content, out, i);
      if (rx) {
        while (i < rx.endIdx) {
          out.push(content[i]);
          i++;
        }
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * Replace string literal contents, regex literal contents, and comments with spaces while preserving
 * line breaks and character offsets (used for accurate parenthesis balancing and keyword scanning).
 */
function maskCodeStringsAndComments(content, isPy = false) {
  const out = [];
  let i = 0;
  const len = content.length;
  while (i < len) {
    const ch = content[i];
    if (isPy && (ch === '"' || ch === "'")) {
      const triple = content.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        out.push('"', " ", " ");
        i += 3;
        while (i < len && content.slice(i, i + 3) !== triple) {
          if (content[i] === "\\" && i + 1 < len) {
            out.push(" ", content[i + 1] === "\n" ? "\n" : " ");
            i += 2;
          } else {
            out.push(content[i] === "\n" || content[i] === "\r" ? content[i] : " ");
            i++;
          }
        }
        if (i < len) {
          out.push(" ", " ", '"');
          i += 3;
        }
        continue;
      }
    }
    if (ch === '"' || ch === "'" || (!isPy && ch === "`")) {
      const quote = ch;
      out.push(quote);
      i++;
      while (i < len && content[i] !== quote) {
        if (content[i] === "\\" && i + 1 < len) {
          out.push(" ", content[i + 1] === "\n" ? "\n" : " ");
          i += 2;
        } else {
          if (quote !== "`" && (content[i] === "\n" || content[i] === "\r")) {
            break;
          }
          out.push(content[i] === "\n" || content[i] === "\r" ? content[i] : " ");
          i++;
        }
      }
      if (i < len && content[i] === quote) {
        out.push(quote);
        i++;
      }
      continue;
    }
    if (isPy && ch === "#") {
      while (i < len && content[i] !== "\n" && content[i] !== "\r") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (!isPy && ch === "/" && content[i + 1] === "/") {
      while (i < len && content[i] !== "\n" && content[i] !== "\r") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (!isPy && ch === "/" && content[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < len && !(content[i] === "*" && content[i + 1] === "/")) {
        out.push(content[i] === "\n" || content[i] === "\r" ? content[i] : " ");
        i++;
      }
      if (i < len) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (!isPy && ch === "/") {
      const rx = findJsRegexLiteral(content, out, i);
      if (rx) {
        out.push("/");
        for (let k = i + 1; k < rx.closeSlashIdx; k++) {
          out.push(" ");
        }
        out.push("/");
        for (let k = rx.closeSlashIdx + 1; k < rx.endIdx; k++) {
          out.push(content[k]);
        }
        i = rx.endIdx;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * Extract single-line and multiline module imports for Python and JS/TS with 1-based line numbers.
 */
function extractModuleImports(content, isPy = false) {
  const fullyMasked = maskCodeStringsAndComments(content, isPy);
  const imports = [];

  if (isPy) {
    // 1. `from <module> import (<names>)` or `from <module> import <names>`
    const fromRegex =
      /(?:^|[\r\n;])[ \t]*from[ \t]+([A-Za-z0-9_.]+)[ \t]+import[ \t]+(?:\(([\s\S]*?)\)|([^\r\n;]+))/g;
    let fm;
    while ((fm = fromRegex.exec(fullyMasked)) !== null) {
      const modSpec = fm[1];
      const namesRaw = (fm[2] ?? fm[3] ?? "").replace(/\\/g, " ");
      const kwIdx = fm.index + fm[0].search(/\bfrom\b/);
      const lineNum = fullyMasked.slice(0, kwIdx).split("\n").length;

      imports.push({ type: "py", spec: modSpec, displaySpec: modSpec, lineNum });

      for (const rawPart of namesRaw.split(",")) {
        const sym = rawPart.trim().split(/\s+/)[0];
        if (sym && sym !== "*" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(sym)) {
          const combined = modSpec.endsWith(".") ? `${modSpec}${sym}` : `${modSpec}.${sym}`;
          imports.push({
            type: "py",
            spec: combined,
            displaySpec: combined,
            lineNum,
          });
        }
      }
    }

    // 2. `import <mod1>, <mod2>`
    const impRegex = /(?:^|[\r\n;])[ \t]*import[ \t]+([A-Za-z0-9_., \t]+)/g;
    let im;
    while ((im = impRegex.exec(fullyMasked)) !== null) {
      const kwIdx = im.index + im[0].search(/\bimport\b/);
      const lineNum = fullyMasked.slice(0, kwIdx).split("\n").length;
      for (const part of im[1].split(",")) {
        const mod = part.trim().split(/\s+/)[0];
        if (mod) {
          imports.push({ type: "py", spec: mod, displaySpec: mod, lineNum });
        }
      }
    }
  } else {
    // 1a. `import ... from '...'` and `export ... from '...'` (clause cannot cross statement boundaries)
    const esmClause =
      "(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\\s*,\\s*(?:\\*\\s+as\\s+[A-Za-z_$][A-Za-z0-9_$]*|\\{[^{};()]*\\}))?|\\*(?:\\s+as\\s+[A-Za-z_$][A-Za-z0-9_$]*)?|\\{[^{};()]*\\})";
    const esmFromRegex = new RegExp(
      `(?<![.\\w$])(?:import|export)\\s+(?:type\\s+)?(${esmClause})\\s+from\\s*(['"])([ \\t]*)\\2`,
      "g"
    );
    let em;
    while ((em = esmFromRegex.exec(fullyMasked)) !== null) {
      const specLen = em[3].length;
      const specStart = em.index + em[0].length - 1 - specLen;
      const spec = content.slice(specStart, specStart + specLen).trim();
      if (spec) {
        const lineNum = fullyMasked.slice(0, em.index).split("\n").length;
        imports.push({ type: "js", spec, displaySpec: spec, lineNum });
      }
    }

    // 1b. Side-effect `import '...'`
    const esmSideEffectRegex = /(?<![.\w$])import\s*(['"])([ \t]*)\1/g;
    let sm;
    while ((sm = esmSideEffectRegex.exec(fullyMasked)) !== null) {
      const specLen = sm[2].length;
      const specStart = sm.index + sm[0].length - 1 - specLen;
      const spec = content.slice(specStart, specStart + specLen).trim();
      if (spec) {
        const lineNum = fullyMasked.slice(0, sm.index).split("\n").length;
        imports.push({ type: "js", spec, displaySpec: spec, lineNum });
      }
    }

    // 2. `require('...')` or dynamic `import('...')`
    const reqRegex = /(?<![.\w$])(?:require|import)\s*\(\s*(['"])([ \t]*)\1(?=\s*\))/g;
    let rm;
    while ((rm = reqRegex.exec(fullyMasked)) !== null) {
      const specLen = rm[2].length;
      const specStart = rm.index + rm[0].length - 1 - specLen;
      const spec = content.slice(specStart, specStart + specLen).trim();
      if (spec) {
        const lineNum = fullyMasked.slice(0, rm.index).split("\n").length;
        imports.push({ type: "js", spec, displaySpec: spec, lineNum });
      }
    }
  }

  return imports;
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
