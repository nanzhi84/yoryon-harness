import fs from "node:fs";
import path from "node:path";

function todayDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toSlug(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parse `issue#15` or `15` into an integer issue number.
 */
function parseIssueNumber(input) {
  if (!input || input.startsWith("--")) return null;
  const m = String(input).trim().match(/^(?:issue#?)?(\d+)$/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * `harness spec new <issue#<N> | <N>> [--title <title>] [--module <module>]`
 */
export function createSpec(targetRoot, rawIssueArg, options = {}) {
  const issueNum = parseIssueNumber(rawIssueArg);
  if (issueNum === null) {
    console.error(
      'Usage: harness spec new <issue#<N> | <N>> [--title "<title>"] [--module "<architecture-module>"]'
    );
    return 1;
  }

  const folderName = `issue#${issueNum}`;
  const specDir = path.join(targetRoot, "docs/spec", folderName);
  const specFilePath = path.join(specDir, "spec.md");

  if (fs.existsSync(specDir)) {
    console.error(`Spec directory already exists: docs/spec/${folderName}`);
    return 1;
  }

  fs.mkdirSync(specDir, { recursive: true });

  const titleText = options.title || `Issue #${issueNum} Specification`;
  const moduleNote = options.module || "[docs/architecture/overview.md](../../architecture/overview.md)";
  const content = `# ${titleText}

> **Status:** Proposal · Issue #${issueNum} · Created ${todayDateString()}
> **Affected Architecture:** ${moduleNote}

## 1. 背景与目标 (Context & Goals)

<!-- 简述本次 Issue 改动要解决的核心问题、业务背景与目标边界 -->

## 2. 方案设计 (Design & Contracts)

<!-- 详细描述方案设计；若包含 UI 矩阵、分册设计、Checklist 或验证快照，可直接放在本 issue#${issueNum}/ 目录下并在此索引 -->

## 3. 真实执行与验收标准 (Verification)

<!-- 描述端到端真实运行验收的输入、预期产物与核对方式 -->
`;

  fs.writeFileSync(specFilePath, content, "utf8");
  console.log(`Created spec: docs/spec/${folderName}/spec.md`);
  return 0;
}

/**
 * Scan both `docs/adr/` and `docs/adr/superseded/` to find the highest 4-digit ADR number.
 */
function getNextAdrNumber(targetRoot) {
  const dirs = [
    path.join(targetRoot, "docs/adr"),
    path.join(targetRoot, "docs/adr/superseded"),
  ];
  let maxNum = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^(\d{4})-/);
      if (m) {
        const num = parseInt(m[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }
  return String(maxNum + 1).padStart(4, "0");
}

function findAdrByPrefix(dir, idInput) {
  if (!fs.existsSync(dir)) return null;
  const padded = String(parseInt(idInput, 10)).padStart(4, "0");
  const files = fs.readdirSync(dir);
  return files.find((f) => f.startsWith(`${padded}-`) && f.endsWith(".md")) || null;
}

/**
 * `harness adr new <slug>`
 */
export function createAdr(targetRoot, rawTitle, { supersedes = null } = {}) {
  const slug = toSlug(rawTitle);
  if (!slug) {
    console.error("Usage: harness adr new <decision-slug>");
    return { code: 1, filename: null };
  }

  const adrDir = path.join(targetRoot, "docs/adr");
  fs.mkdirSync(adrDir, { recursive: true });

  const num = getNextAdrNumber(targetRoot);
  const filename = `${num}-${slug}.md`;
  const filePath = path.join(adrDir, filename);

  const supersedesLine = supersedes
    ? `- **取代决策 (Supersedes)**：[${supersedes}](superseded/${supersedes})\n`
    : "";

  const content = `# ADR-${num}: ${rawTitle}

- **状态 (Status)**：Accepted
- **日期 (Date)**：${todayDateString()}
${supersedesLine}
## 1. 背景与上下文 (Context)

<!-- 描述促使做出该架构决策的技术背景、业务约束与核心问题 -->

## 2. 决策方案 (Decision)

<!-- 描述最终选定的技术方案与关键权衡 -->

## 3. 影响与后果 (Consequences)

<!-- 描述该决策带来的正面收益、潜在代价与后续演进边界 -->
`;

  fs.writeFileSync(filePath, content, "utf8");
  console.log(`Created ADR: docs/adr/${filename}`);
  return { code: 0, num, filename, filePath };
}

/**
 * `harness adr supersede <old-id> <new-slug-or-id> [--reason "..."]`
 */
export function supersedeAdr(targetRoot, oldIdInput, newTargetInput, options = {}) {
  if (!oldIdInput || !newTargetInput) {
    console.error(
      'Usage: harness adr supersede <old-adr-number> <new-adr-slug-or-number> [--reason "why old decision was superseded"]'
    );
    return 1;
  }

  const adrDir = path.join(targetRoot, "docs/adr");
  const supersededDir = path.join(adrDir, "superseded");
  fs.mkdirSync(supersededDir, { recursive: true });

  const oldFilename = findAdrByPrefix(adrDir, oldIdInput);
  if (!oldFilename) {
    console.error(`Could not find active ADR matching '${oldIdInput}' in docs/adr/.`);
    return 1;
  }

  // Check if newTargetInput refers to an existing ADR in docs/adr/ or if we should create a new one
  let newFilename = null;
  if (/^\d+$/.test(newTargetInput)) {
    newFilename = findAdrByPrefix(adrDir, newTargetInput);
    if (!newFilename) {
      console.error(`Could not find target ADR matching '${newTargetInput}' in docs/adr/.`);
      return 1;
    }
  } else if (newTargetInput.endsWith(".md") && fs.existsSync(path.join(adrDir, newTargetInput))) {
    newFilename = newTargetInput;
  } else {
    const created = createAdr(targetRoot, newTargetInput, { supersedes: oldFilename });
    if (created.code !== 0) return created.code;
    newFilename = created.filename;
  }

  const newNum = newFilename.slice(0, 4);
  const oldAbsPath = path.join(adrDir, oldFilename);
  let oldContent = fs.readFileSync(oldAbsPath, "utf8");

  // Update status line to Superseded by ADR-NNNN (relative from docs/adr/superseded/ to docs/adr/)
  const supersededStatusText = `Superseded by [ADR-${newNum}](../${newFilename})`;
  if (/(?:状态|Status).*[:：]/i.test(oldContent)) {
    oldContent = oldContent.replace(
      /(- \*\*(?:状态\s*\(Status\)|状态|Status)\*\*\s*[:：]\s*).*/i,
      `$1${supersededStatusText}`
    );
  } else {
    oldContent = `- **状态 (Status)**：${supersededStatusText}\n\n` + oldContent;
  }

  const reason =
    options.reason ||
    `已被 [ADR-${newNum}](../${newFilename}) 取代，请在此补充原方案在实际落地中遇到的问题或失效原因。`;

  if (!oldContent.includes("## 失效说明")) {
    oldContent =
      oldContent.trimEnd() +
      `\n\n## 失效说明 (Superseded Note)\n\n- **失效日期**：${todayDateString()}\n- **原因总结**：${reason}\n`;
  }

  const archivedAbsPath = path.join(supersededDir, oldFilename);
  fs.writeFileSync(archivedAbsPath, oldContent, "utf8");
  fs.unlinkSync(oldAbsPath);

  console.log(`Superseded ADR: moved docs/adr/${oldFilename} -> docs/adr/superseded/${oldFilename}`);
  console.log(`Linked to active ADR: docs/adr/${newFilename}`);
  return 0;
}
