# Changelog

本项目的所有重要版本变更、新特性汇总与修复记录均归档于此。

## [Unreleased]

### Fixed
- 修复 `src/clean.js` 中 `cleanWorktrees` 在清理项目注册表失效 `environments` 时未校验 `worktreeContainerDirs` 容器边界的误删隐患：新增 `isInsideWorktreeContainers` 与 `isSafeWtTarget` 严格路径包含守卫，仅当失效环境路径明确位于受管 `worktreeContainerDirs` 子目录内（且非仓库根目录、家目录、文件系统根目录或仓库祖先目录）时才清理物理空壳目录，外部目录仅剔除注册表 JSON 中的失效记录而绝不触碰磁盘文件。
- 修复 `Previous Worktrees` 在 Antigravity UI 删除或 CLI 移除后清理不彻底的问题：`src/hook.js` 中的 `.git/hooks/reference-transaction` 注入完整 `PATH` 并改为同步执行（避免后台 `&` 子进程被短生命周期 `git` 命令提前终止），`src/clean.js` 新增防重入守卫、对已移除 worktree 残留的已合并本地分支自动执行 `git branch -d` 兜底，并将项目注册表 JSON 改为 `.tmp` + `fs.renameSync` 原子替换以立即触发 `language_server` `fsnotify/kqueue` 刷新；`harness sync` 现同步自动升级 `.git/hooks/`。
- 修复 `src/doctor.js` 巡检误扫 Python 虚拟环境与临时协作目录的问题：`IGNORED_WALK_DIRS` 新增忽略 `.venv`、`venv`、`teamwork` 及缓存目录。

### Added
- 落地跨三仓实证调研（`docs/reference/harness_recurring_issues_survey_zh.md`）全部 12 项通用 Harness 抽象下沉提案（PROP-01 ~ PROP-12）：
  - `DIR001`（PROP-09）：仓库根目录与 `docs/` 目录防污染白名单守卫，拦截 `docs/` 下非标子目录及根目录散落截图/二进制文件（支持 `.agents/harness.json` `rootAllowlist` 扩展）。
  - `TST003`（PROP-01）：基于 `.agents/harness.json` `protectedPaths` 的只读裁判与验收基线目录锁定守卫。
  - `MTX001`（PROP-02）：基于 `.agents/harness.json` `protectedMatrices` 的 CSV/TSV 不可变列保护锁，并在 `harness hook run` 中支持自动从 `HEAD` 还原被篡改单元格。
  - `harness tdd verify --test "<cmd>"`（PROP-03，`src/tdd.js`）：自动化红绿 TDD 因果契约校验器（阶段 1 回退非测试改动验证旧基线必败，阶段 2 恢复实现验证必过，生成 `tdd_receipt.json`）。
  - `AGENTS.md` / `PROJECTS.md` / `.agents/harness.json` 三层边界收敛与 `harness sync` 自动配置 `.agents/hooks.json` Stop 钩子（PROP-04）。
  - `TST001` 多语言对称扩展（PROP-05）：支持 TypeScript / JavaScript（Vitest / Jest）测试文件命名与 `describe("Test<Subject>", ...)` + `it("test_<scenario>_<expected>", ...)` 层级契约校验。
  - 动态工具链与虚拟环境 `PATH` 归一化器（PROP-06）：自动注入 `.venv/bin`、`node_modules/.bin`、`~/.cargo/bin`、`~/.local/bin`。
  - `.agents/harness.json` `worktreeSharedPaths` 自动软链（PROP-07）：在子 Git worktree 执行 `harness run` 或 `harness hook` 时自动软链主仓共享路径。
  - Worktree 清理并发活跃度保护（PROP-08）：`cleanWorktrees` 增加 `.git/index.lock` 锁检测与 mtime 冷却窗口，防并发创建期间竞态误删。
  - 增量代码格式门禁与 `harness hook run --staged`（PROP-10）：针对 Git 变更文件增量执行 `ruff format --check` 与 `prettier --check`。
  - 感知 `.gitignore` 的动态扫描器（PROP-11）：基于 `git ls-files -co --exclude-standard` 消除忽略目录误报。
  - `AST001` / `AST002` / `TST004`（PROP-12）：基于 `.agents/harness.json` `architecture` 的声明式分层单向依赖守卫、核心目录禁用字面量守卫，以及测试子进程 `timeout` 参数必传检查。
- 新增声明式多 Agent Worktree 容器与项目环境注册表自动回收能力（`harness clean --worktrees` 及 `src/clean.js` 中的 `DEFAULT_AGENT_WORKTREE_SPECS` / `cleanWorktrees`）：内置 Antigravity、Cursor、Claude Code、Codex 路径模板（支持 `~`、`{home}`、`{repo}`、`{repoRoot}` 占位符及 `.agents/harness.json` / `~/.config/harness/config.json` 扩展声明），基于 `git rev-parse --git-common-dir` 与 `.git/worktrees/*/gitdir` 自动清理孤儿 worktree 空壳目录、同步剔除项目注册表中已失效的 `environments` 条目并修正已删除的 `defaultBranch`、执行 `git worktree prune --expire now`、刷新 `.git/info/refs` 并回收 `refs/heads/` 空目录；同时在 `harness hook install --git` 中自动挂载 `.git/hooks/reference-transaction` 钩子。
- 新增测试契约静态巡检规则 `TST001`（拦截 `tests/` 下阶段/序号命名及未归入 `class Test<Subject>:` 的裸测试函数或单词方法名）与 `TST002`（拦截 `unittest.mock`、`MagicMock`、`monkeypatch.setattr`、`jest.mock` 等业务打桩，放行 `monkeypatch.setenv`/`delenv` 并支持 `# harness-ignore CODE: 原因` 豁免）。
- 升级 `src/hook.js` (`harness hook run --agent`)：内置 `terminationReason == "NO_TOOL_CALL"` 正常回合守卫，以及多语言静态类型与 Linter 零容忍检查（自动探测并解析 `.venv/bin/pyright`、`pyrefly`、`ruff`、`eslint`、`tsc` 的错误与警告 JSON）。
- 新增 `harness clean` 命令及 `src/clean.js` 沙盒 TTL / 配额清理模块，并在 `harness hook run` 与 `harness run` 中内置自动过期清理。
- 升级 `AGENTS.md` 与 `PROJECTS.md` 规范母本：确立三要素黑盒测试命名规范，以及 `PROJECTS.md` 与 `docs/adr/` 的职责边界红线。
- 初始化项目 Universal Harness 目录结构与文档规范。
