# Changelog

本项目的所有重要版本变更、新特性汇总与修复记录均归档于此。

## [Unreleased]

### Added
- `harness watch` 与 `harness run` 新增 `--tty` / `--no-tty` 终端兼容开关及外层真实非 `dumb` 终端自动透传（[src/watch.js](src/watch.js)、[src/run.js](src/run.js)、[bin/harness.js](bin/harness.js)）：外层具备真终端且非 `dumb`/`unknown` 时自动向子进程注入 `TTY_COMPATIBLE=1`、`COLUMNS` 与 `LINES`；显式传入 `--tty` 时补齐 `FORCE_COLOR=1`、`CLICOLOR_FORCE=1` 与兜底 `TERM=xterm-256color`，保持 `stdout`/`stderr` 严格分流，并在外层为非终端管道时自动对连续相同原地重绘帧进行内容去重及 `DEFAULT_REDRAW_THROTTLE_MS`（10 秒）时间窗口节流，同时在普通非重绘输出前与子进程结束时补刷最后一帧。

### Fixed
- 修复 [src/watch.js](src/watch.js) `inspectLines` 仅按 `\r?\n` 切分导致裸 `\r` 进度条累积 `partial` 缓冲、以及原地重绘进度帧（裸 `\r` 或含 ANSI 光标控制序列）被误判为 `LOOP_DETECTED` 熔断的问题，同时保留带 SGR 颜色码错误日志的死循环熔断能力。

### Removed
- 移除 `templates/AGENTS.md` 中的手动“静态与契约检查”条款（Issue #2）：静态类型、Linter 与契约巡检统一收归自动化 Git `pre-commit` 与轻量 `Stop` 钩子守护，违规时由钩子按需注入规则说明与豁免指引，消除提示词驱使模型重复跑全仓 `pyright` 的时间开销。
- 移除 `harness tdd verify` 命令及相关实现（`src/tdd.js`、`src/tdd-files.js`、`tests/tdd_restoration.test.js`）：进程级 `exitCode !== 0` 红灯校验在 Agent 批量编写多条测试用例时存在单条用例失败或 `ImportError` 即整体放行的搭便车漏洞，统一收敛为静态测试契约巡检（`TST001`~`TST004`）、独立子代理（Fresh Subagent）黑盒盲写测试与 `harness run` 隔离沙盒真实验收。

### Changed
- 门禁职责分级与跨阶段指纹去重（Issue #2）：
  - `harness hook run --agent`（`Stop` 钩子）收敛为亚秒级轻量结构与反作弊护栏（仅对未验证脏工作区执行 `doctor` 与 `MTX001` 自动还原，跳过重型外部类型检查器以免阻塞 Fresh Subagent TDD 红灯阶段与半成品交互），并接入 `<git-dir>/harness-verify-cache.json` 内容寻址指纹与 `lastPassedStepIndex` 游标快速短路。
  - `harness hook run --staged`（Git `pre-commit` 钩子）重构为 `Promise.all` 并发执行 `doctor` 与按 `allTouchedPaths`（含删除路径 `D`）精确门控的静态检查（Pyright、显式配置的 Pyrefly、Ruff、Ruff Format、ESLint、Prettier、TSC），修复 `ruff` / `eslint` 空变更回退全仓扫描与未配置仓库隐式强拉 IDE 插件 `pyrefly` 的问题，并通过 `git write-tree` 预签发提交后新树指纹实现跨阶段零重复扫描。
- 默认根目录白名单收紧为 10 个通用工作区目录；框架、编辑器和业务目录由各项目 `.agents/harness.json` 的 `rootAllowlist` 显式声明。根目录权限不再复用递归内容扫描的依赖/构建排除名单，保留 Git 忽略及已声明共享路径语义。

### Fixed
- 修复 `src/watch.js` 固定忽略 `stdin` 导致 Shell Heredoc（`<< 'EOF'`）读取为空及单参数模式不支持 `$SHELL` 语法的问题，同时在 `src/hook-tools.js` 中补齐 `sh` / `bash` / `zsh` `-c` 解包与协作调度工具（`send_message`、`schedule`、`define_subagent`、`research` 子代理、`swarm` 状态查询）只读识别（Issue #2）。
- 修复 `src/watch.js`（`runWatchedProcess`）在宿主会话取消或中断时未向 `detached: true` 独立子进程组级联转发终止信号的问题：新增宿主 `SIGTERM` / `SIGINT` / `SIGHUP` 监听并立即向 `-child.pid` 转发对应信号，支持 500ms 宽限期后升级 `SIGKILL` 强制收割顽固子/孙进程、等待进程组彻底消亡后按标准信号退出码（`143` / `130` / `129`）返回，并在任意结束分支自动解绑宿主信号监听器实现零泄漏。
- 修复 `harness hook run --agent` 在纯只读回合（纯问答、仅调用 `read_file`/`grep_search` 等只读工具、仅执行 `git status`/`git diff`/`ls`/`cat`/`harness doctor` 等只读 Shell 命令、或修改类调用被拒绝报错）结束时仍无条件触发沙盒清理与全套静态检查的问题：`src/hook-tools.js` 新增 `isReadOnlyShellCommand`、`isReadOnlyToolCall` 与 `isReadOnlyAgentTurn`（解析 `stdin` 的 `transcriptPath` 最新 `USER_INPUT` 后的工具调用记录及 `transcript_full.jsonl` 回退），只读回合直接返回 `{"decision":"stop"}` 放行。
- 修复 `src/clean.js` 对远端跟踪分支显示为 `[gone]` 的本地分支与干净子 worktree 未校验代码是否已合入主分支即强制删除的风险：新增 `git merge-tree --write-tree` 模拟合并等价性校验（结合 `git for-each-ref --merged` 祖先检查），仅当分支净改动已完整包含于主分支（含普通 Merge、Rebase Merge 与多提交 Squash Merge）时才移除干净子 worktree 并执行 `git branch -D`，对远端分支未合并直接删除或本地尚有未推送新提交的分支严格保留。
- 从默认根目录白名单移除 `scripts/`，统一由 `DIR001` 检查；保留项目显式 `rootAllowlist` 扩展能力。
- 修复 hook 升级截断用户追加逻辑：为受管片段增加结束标记，识别已发布旧脚本并保留片段外原文；未知旧片段拒绝覆盖。
- 修复 `harness tdd verify` 将新增符号链接恢复为普通文件的问题：保存文件类型与原始链接目标，支持相对、悬空链接，并按 Git 文件模式恢复红灯基线，避免写入外部链接目标。
- 修复 `src/clean.js` 中 `cleanWorktrees` 在清理项目注册表失效 `environments` 时未校验 `worktreeContainerDirs` 容器边界的误删隐患：新增 `isInsideWorktreeContainers` 与 `isSafeWtTarget` 严格路径包含守卫，仅当失效环境路径明确位于受管 `worktreeContainerDirs` 子目录内（且非仓库根目录、家目录、文件系统根目录或仓库祖先目录）时才清理物理空壳目录，外部目录仅剔除注册表 JSON 中的失效记录而绝不触碰磁盘文件。
- 修复 `Previous Worktrees` 在 Antigravity UI 删除或 CLI 移除后清理不彻底的问题：`src/hook.js` 中的 `.git/hooks/reference-transaction` 注入完整 `PATH` 并改为同步执行（避免后台 `&` 子进程被短生命周期 `git` 命令提前终止），`src/clean.js` 新增防重入守卫、对已移除 worktree 残留的已合并本地分支自动执行 `git branch -d` 兜底，并将项目注册表 JSON 改为 `.tmp` + `fs.renameSync` 原子替换以立即触发 `language_server` `fsnotify/kqueue` 刷新；`harness sync` 现同步自动升级 `.git/hooks/`。
- 修复 `src/doctor.js` 巡检误扫 Python 虚拟环境与临时协作目录的问题：`IGNORED_WALK_DIRS` 新增忽略 `.venv`、`venv`、`teamwork` 及缓存目录。

### Added
- 新增命令看门狗引擎（`src/watch.js`、`harness watch`）与 `PreToolUse` 强制门禁钩子（`harness hook pre-tool`）：
  - `harness hook install --agents`（及 `init`/`sync`）在 `.agents/hooks.json` 中同时注册 `PreToolUse`（匹配 `run_command` 调用 `harness hook pre-tool`）与 `Stop` 钩子。
  - `harness hook pre-tool` 强制要求每次非守护进程命令必须显式通过 `harness watch --timeout <duration> [--idle-timeout 5m] [--max-repeat 100] -- <cmd>`（或 `harness run <task> --timeout <duration> -- <cmd>`）执行，并静态拦截 `while true` / `for ((;;))` 等手写轮询死循环。
  - `harness watch` 提供独立进程组级总时长硬超时（`WALL_TIMEOUT`）、默认 `5m` 静默无输出挂起熔断（`IDLE_TIMEOUT`）、默认连续 `100` 行重复刷屏死循环熔断（`LOOP_DETECTED`）及 `stdin` 关闭保护，超时或熔断时级联清理整个子进程组并以退出码 `124` 返回诊断信息；同时 `isReadOnlyShellCommand` 支持自动解包 `harness watch` 包装以保留只读回合快速放行语义。
- 新增 PR 合并后远端与本地分支/Worktree 闭环自动清理：`harness init`、`harness sync` 与 `harness hook install` 自动开启本地 `git config --local fetch.prune true`，并自动检测 `origin` GitHub 远端调用 `gh repo edit <owner>/<repo> --delete-branch-on-merge` 开启云端自动删分支（缓存至 `harness.ghDeleteBranchOnMerge`，未绑定远端或 `gh` 失败时打印提醒且不阻塞本地命令）；`src/clean.js`（`cleanWorktrees`）自动识别并删除已合入主干的本地分支及上游远端引用已消失（`[gone]`，含 Squash / Rebase Merge 场景）的本地分支，对绑定了 `[gone]` 分支且工作区干净的子 worktree 自动卸载目录并清理分支，对存在未提交改动的子 worktree 严格保留。
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
