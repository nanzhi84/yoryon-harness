import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "../templates");

const REQUIRED_DIRS = [
  "docs/architecture",
  "docs/spec",
  "docs/adr/superseded",
  "docs/runbooks",
  "docs/reference",
  "tests",
  "work",
  "artifacts",
];

const GITIGNORE_ENTRIES = ["work/", "artifacts/"];

/**
 * Ensure `.gitignore` exists and contains `work/` and `artifacts/`.
 */
function ensureGitignore(targetRoot) {
  const gitignorePath = path.join(targetRoot, ".gitignore");
  let existing = "";
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, "utf8");
  }

  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const missing = GITIGNORE_ENTRIES.filter((entry) => {
    const bare = entry.replace(/\/$/, "");
    return !lines.includes(entry) && !lines.includes(bare) && !lines.includes(`/${entry}`);
  });

  if (missing.length === 0 && fs.existsSync(gitignorePath)) {
    return false;
  }

  const prefix =
    existing.length > 0 && !existing.endsWith("\n")
      ? `${existing}\n\n`
      : existing.length > 0
        ? `${existing}\n`
        : "";
  const block = `# Universal Harness runtime & verification sandboxes\n${missing.join("\n")}\n`;
  fs.writeFileSync(gitignorePath, `${prefix}${block}`, "utf8");
  return true;
}

/**
 * Copy a file from `templates/` to `targetRoot`.
 */
function copyTemplateFile(relPath, targetRoot, { overwrite = false } = {}) {
  const srcPath = path.join(TEMPLATES_DIR, relPath);
  const destPath = path.join(targetRoot, relPath);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const existed = fs.existsSync(destPath);
  if (existed && !overwrite) {
    return { status: "skipped", relPath };
  }
  fs.copyFileSync(srcPath, destPath);
  return { status: existed && overwrite ? "updated" : "created", relPath };
}

/**
 * `harness init`: Initialize directory skeleton and templates in target directory.
 */
export function runInit(targetRoot = process.cwd(), options = {}) {
  const { force = false } = options;
  const actions = [];

  for (const dir of REQUIRED_DIRS) {
    const fullDir = path.join(targetRoot, dir);
    if (!fs.existsSync(fullDir)) {
      fs.mkdirSync(fullDir, { recursive: true });
      actions.push(`mkdir   ${dir}/`);
    }
  }

  // Copy core specification & template files
  const templateFiles = [
    { path: "AGENTS.md", overwrite: force },
    { path: "docs/README.md", overwrite: force },
    { path: "README.md", overwrite: false },
    { path: "PROJECTS.md", overwrite: false },
    { path: "CHANGELOG.md", overwrite: false },
    { path: "docs/architecture/overview.md", overwrite: false },
    { path: "docs/reference/INDEX.md", overwrite: false },
  ];

  for (const item of templateFiles) {
    const res = copyTemplateFile(item.path, targetRoot, { overwrite: item.overwrite });
    actions.push(`${res.status.padEnd(7)} ${res.relPath}`);
  }

  // Keep .gitkeep in empty tracked dirs if those dirs have no files yet
  const gitkeepDirs = [
    "docs/spec",
    "docs/adr/superseded",
    "docs/runbooks",
    "tests",
  ];
  for (const dir of gitkeepDirs) {
    const fullDir = path.join(targetRoot, dir);
    const entries = fs.readdirSync(fullDir);
    if (entries.length === 0) {
      fs.writeFileSync(path.join(fullDir, ".gitkeep"), "", "utf8");
    }
  }

  if (ensureGitignore(targetRoot)) {
    actions.push("merged  .gitignore (work/, artifacts/)");
  } else {
    actions.push("ok      .gitignore");
  }

  console.log(`Universal Harness initialized in ${targetRoot}:`);
  for (const line of actions) {
    console.log(`  ${line}`);
  }
}

/**
 * `harness sync`: Upgrade only universal specification files (`AGENTS.md` and `docs/README.md`)
 * and ensure required directories + `.gitignore` rules exist, without touching project-specific docs.
 */
export function runSync(targetRoot = process.cwd()) {
  const actions = [];

  for (const dir of REQUIRED_DIRS) {
    const fullDir = path.join(targetRoot, dir);
    if (!fs.existsSync(fullDir)) {
      fs.mkdirSync(fullDir, { recursive: true });
      actions.push(`mkdir   ${dir}/`);
    }
  }

  const universalFiles = ["AGENTS.md", "docs/README.md"];
  for (const relPath of universalFiles) {
    copyTemplateFile(relPath, targetRoot, { overwrite: true });
    actions.push(`synced  ${relPath}`);
  }

  if (ensureGitignore(targetRoot)) {
    actions.push("merged  .gitignore (work/, artifacts/)");
  }

  console.log(`Universal Harness synced in ${targetRoot}:`);
  for (const line of actions) {
    console.log(`  ${line}`);
  }
}
