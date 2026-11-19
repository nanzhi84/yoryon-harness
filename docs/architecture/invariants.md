# 系统不变量与横切约束 (Invariants & Cross-cutting)

> 本文件记录 `yoryon-harness` 不可违反的系统级不变量、安全边界与明确的非目标。

## 1. 核心不变量

1. **非破坏性初始化与同步（[src/init.js](../../src/init.js)）**
   - `harness init` 在未传 `--force` 时，严禁覆盖目标仓库已有的任何文件；`.gitignore` 采用按行去重追加策略确保 `work/` 与 `artifacts/` 被忽略。
   - `harness sync` 仅覆盖更新通用协议文件（`AGENTS.md` 与 `docs/README.md`）并同步确保 `.git/hooks/` 与 `.agents/hooks.json` 守护钩子就绪，绝不触碰项目特异文件（`README.md`、`PROJECTS.md`、`docs/architecture/`、`docs/reference/INDEX.md`、`.agents/harness.json`）。
2. **结构、固定架构槽位与反作弊完备性（[src/doctor.js](../../src/doctor.js)）**
   - `DIR001`：`docs/` 下严格只允许 `README.md` 及 4 个标准子目录（`architecture/`、`adr/`、`runbooks/`、`reference/`），明确禁止 `docs/spec/`；`docs/architecture/` 下严格只允许 5 个固定文件（必填 `overview.md`、`data-flow.md`、`data-model.md`、`invariants.md`，按需 `deployment.md`），禁止子目录及任意平铺专题文件；仓库根目录明确禁止 `CHANGELOG.md`（即使写入 `rootAllowlist` 亦拒绝）及未授权二进制截图、压缩包或临时脚本。默认根目录仅保留 `.git`、`.agents`、`bin`、`src`、`docs`、`tests`、`work`、`artifacts`、`experiments`、`dist`；项目、框架及编辑器目录必须在 `.agents/harness.json` 的 `rootAllowlist` 中显式声明（支持名称和 glob），不由核心代码预置技术栈。根目录检查仍遵循 Git 忽略规则；递归内容扫描的依赖/缓存排除名单不构成根目录放行权限；`worktreeSharedPaths` 作为项目显式共享路径声明继续放行对应顶层目录。
   - `ARC001`：`docs/architecture/overview.md` 与 `docs/architecture/data-flow.md` 各自必须至少包含 1 个 `mermaid` 图表块。
   - `ADR001` / `ADR002`、`REF001`、`LNK001` / `LNK002`：强制保证 ADR 生命周期位置、参考资料索引登记与本地链接/锚点精确匹配。
   - `TST001` ~ `TST004`：`tests/` 下严禁阶段/序号命名测试文件，Python（`class Test<Subject>:` + `def test_<scenario>_<expected>()`）与 TS/JS（`describe("Test<Subject>", ...)` + `it("test_<scenario>_<expected>", ...)`）对称强制层级与两段式命名；严禁业务 Mock（`TST002`）；锁定 `.agents/harness.json` `protectedPaths` 只读裁判基线（`TST003`）；强制测试内 `subprocess.run` / `spawnSync` / `execSync` 显式传入 `timeout`（`TST004`）。
   - `MTX001`、`AST001` / `AST002`：按 `.agents/harness.json` 锁定 CSV/TSV `immutableColumns` 不可篡改，以及声明式分层依赖方向与核心目录禁用字面量正则。
3. **门禁职责分级与跨阶段指纹去重（[src/hook.js](../../src/hook.js)、[src/hook-tools.js](../../src/hook-tools.js)、[src/hook-checks.js](../../src/hook-checks.js)）**
   - `harness hook run --agent`（`Stop` 钩子）仅在正常回合结束（`terminationReason == "NO_TOOL_CALL"`）时运行轻量上下文契约与反作弊守护（`doctor` + `MTX001` 自动从 `HEAD` 还原不可变列单元格 + 沙盒清理，**不启动重型外部类型检查器**以免阻塞 TDD 红灯阶段）；若新增步骤仅含只读/调度操作，或工作区内容摘要命中 `<git-dir>/harness-verify-cache.json`，直接放行。
   - `harness hook run --staged`（Git `pre-commit` 钩子）并行执行 `doctor` 与按 `allTouchedPaths`（含删除路径 `D`）精确门控的并发静态检查（Pyright、显式配置的 Pyrefly、Ruff、Ruff Format、ESLint、Prettier、TSC），并在无额外未暂存修改时预签发提交后新树指纹。
4. **Worktree 物理目录回收边界与并发活跃度守卫（[src/clean.js](../../src/clean.js)）**
   - 回收失效 worktree 前强制检查 `.git/index.lock` 等锁文件与 mtime 冷却窗口，且仅允许删除严格位于 `worktreeContainerDirs` 容器内部且无有效 `.git` 链接的物理目录；对上游远端已删除（`[gone]`）的本地分支与关联干净 worktree，强制通过 `git for-each-ref --merged` 或 `git merge-tree --write-tree` 校验改动已合入主分支后才允许移除，防止未合并本地提交丢失引用。

## 2. 横切约束与非目标 (Non-goals)

- **零第三方运行时依赖**：运行时仅依赖 Node.js (`>= 18`) 原生 ESM API 与标准系统/语言工具链，确保 `npm link` / `npx` 零安装成本运行。
- **不预置业务技术栈白名单**：核心代码不硬编码特定框架或云厂商目录到根目录白名单，统一交由目标项目的 `.agents/harness.json` 声明。
- **不托管需求规划与发版历史**：不维护仓库内 `docs/spec/` 需求归档库与 `CHANGELOG.md`，分别交由 GitHub Issues / 临时 `work/` 与 GitHub Releases 承载。
