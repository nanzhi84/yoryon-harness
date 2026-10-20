<p align="center">
  <img src="docs/assets/logo.svg" alt="yoryon-harness" width="112">
</p>

<h1 align="center">yoryon-harness</h1>

<p align="center"><strong>渐进式上下文路由 · 可验证的 Agent 执行底座</strong></p>

<p align="center">
  <code>yoryon-harness</code> 是面向 AI Agent 协作工程的个人通用仓库底座（Universal Agent Harness）。
  通过极简上下文路由、按生命周期隔离的文档体系、确定性的结构与死链巡检，以及隔离沙盒执行回执，让编码 Agent 始终在清晰的工程边界内工作与自验。
</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-339933.svg" alt="Node >= 18"></a>
  <a href="docs/README.md"><img src="https://img.shields.io/badge/protocol-Universal%20Harness-0ea5e9.svg" alt="Universal Harness"></a>
</p>

## Core ideas

- **渐进式上下文路由**：顶层 `AGENTS.md` 仅做极简路由表，项目特异红线（`PROJECTS.md`）与五大文档规范（`docs/README.md`）按需加载，避免无关上下文污染。
- **按生命周期隔离文档**：严格区分活架构现状（`architecture/`）、按需关联 GitHub Issue 的增量设计包（`spec/issue#N/`）、带推翻归档链路的架构决策（`adr/` + `superseded/`）、运维手册（`runbooks/`）与定稿封存的外部参考（`reference/`）。
- **重真实运行、轻垃圾单测**：拒绝凑覆盖率的脆弱 Mock 单元测试，通过 `harness run` 在隔离的 `work/` 与 `artifacts/` 沙盒中用真实输入跑通端到端流程并落盘 `receipt.json` 回执。
- **自愈式结构与死链巡检**：内置零依赖 `harness doctor` 巡检引擎，自动校验目录合规、ADR 状态流转、参考索引登记以及 Markdown 本地死链与锚点，并直接输出供 Agent 自修复的指令。

## Get started

将以下指令直接粘贴给你的 Coding Agent（如 Claude Code、Cursor 等），即可为新项目或历史老项目一键接入并对齐 `yoryon-harness`：

```text
请为当前仓库接入 yoryon-harness 并对齐现有文档结构：

1. 在仓库根目录运行 `harness init`，生成标准目录骨架（`AGENTS.md`、`PROJECTS.md`、`CHANGELOG.md`、`docs/{architecture,spec,adr/superseded,runbooks,reference}`、`work/`、`artifacts/`）。
2. 完整阅读 `AGENTS.md` 与 `docs/README.md`，理解五大文档模块的生命周期边界及架构文档的引用规范。
3. 扫描仓库中现有的所有文档、旧规则与配置：
   - 提炼出本项目特有的业务背景、技术栈约束与领域红线，汇总草拟到根目录的 `PROJECTS.md` 中。
   - 列出一张从旧文档路径到新目录（`docs/architecture/`、`docs/spec/issue#N/`、`docs/adr/NNNN-*.md`、`docs/runbooks/`、`docs/reference/` 及 `INDEX.md`）的迁移映射表。
4. 先在终端输出 `PROJECTS.md` 草稿和迁移映射表供我确认，在我批准前不要移动或删除任何已有文件；批准后使用 `git mv` 迁移，并运行 `harness doctor` 直至所有结构与死链检查全部通过。
```

或在终端中手动使用 CLI：

```bash
# 在本仓库执行一次全局注册
cd /Users/yoryon/yoryon-harness && npm link

# 在任意新老项目中初始化骨架（或运行 harness sync 升级通用规范）
harness init

# 按需创建关联 GitHub Issue 的 Spec 与演进 ADR
harness spec new issue#1 --title "UI 矩阵重构方案"
harness adr new use-postgres
harness adr supersede 0001 migrate-to-supabase --reason "需要内置 Auth 与实时订阅能力"

# 在隔离沙盒中执行真实验收并运行全局巡检
harness run verify -- npm test
harness doctor
```

## Learn more

- **协作规范与项目红线**：[AGENTS.md](AGENTS.md) · [PROJECTS.md](PROJECTS.md)
- **文档公约与全局架构**：[文档维护规范](docs/README.md) · [全局架构现状](docs/architecture/overview.md)
- **外部参考与版本记录**：[参考资料索引](docs/reference/INDEX.md) · [CHANGELOG.md](CHANGELOG.md)
