# 门禁职责分级与三重冗余消除规范（`Stop` 轻量反作弊 + `pre-commit` 单点重型门禁）

> **Status:** Accepted · [Issue #2](https://github.com/nanzhi84/yoryon-harness/issues/2) · Created 2026-11-12
> **Affected Architecture:** [docs/architecture/overview.md](../../architecture/overview.md)（涉及 [src/hook.js](../../../src/hook.js)、[src/hook-checks.js](../../../src/hook-checks.js)、[src/hook-tools.js](../../../src/hook-tools.js)、[src/watch.js](../../../src/watch.js)、[templates/AGENTS.md](../../../templates/AGENTS.md)）

## 1. 背景与目标 (Context & Goals)

### 1.1 实测根因归因

在大型混合仓库（如 `WorldLawHarvester`）的高密度实战日志中，`harness watch` 与 `PreToolUse` 本身的进程包装开销极低（合计约 `71 ms`/次），真正拖慢整体吞吐量的瓶颈来自**三重全仓重复检查**与**静态门控粒度过粗**：

1. **提示词层驱使高频手动全仓扫描**：[templates/AGENTS.md](../../../templates/AGENTS.md) 原第 1 条要求任何代码或文档变更后手动运行类型检查、Linter 与 `harness doctor`，导致单晚手动触发 265 次全仓 `pyright`（累计约 52 分钟）与 271 次 `harness doctor`。
2. **`Stop` 钩子越位执行重型类型检查（单次 `12.8s`）**：
   - 不仅与 `git commit` 时的 `pre-commit` 重复执行，还与 **Fresh Subagent TDD 红灯阶段**（刚写完调用未实现目标接口的测试即结束子代理回合）、**后台异步任务挂起（`WaitMsBeforeAsync=500`）**以及**半成品中途澄清交互**产生结构性冲突；
   - [src/hook-tools.js](../../../src/hook-tools.js) 未剥离 `zsh -c` / `bash -c` / `sh -c`，未将协作/调度工具纳入只读集合，且始终回溯至整轮 `USER_INPUT` 起点，导致只读排查与后台等待反复卡顿。
3. **`checkStaticTypes` 缺乏增量门控且存在空变更回退 Bug**：
   - [src/hook-checks.js](../../../src/hook-checks.js) 中 `pyright`、`pyrefly`、`tsc` 完全忽略变更文件集合；`ruff` 与 `eslint` 在非 `--staged` 且变更文件数为 `0` 时反而回退为全仓扫描；未配置 `pyrefly` 时仍从 IDE 插件目录隐式拉起运行；
   - [src/hook-tools.js](../../../src/hook-tools.js) 的 `getChangedFiles()` 使用 `--diff-filter=ACMR` 漏掉了 `D`（已删除文件），直接用于跨文件类型门控会导致删除被引用模块时漏检。
4. **`watch.js` 关闭 Heredoc 标准输入**：[src/watch.js](../../../src/watch.js) 固定 `stdio: ["ignore", "pipe", "pipe"]` 丢弃了 Shell Heredoc（`<< 'PY'`）创建的常规文件 `fd 0`，迫使 Agent 改写为多层引号转义的 `zsh -c` / `python3 -c`（单晚 621 次）。

### 1.2 核心架构原则

- **轻量需在单上下文内即时解决的契约与反作弊护栏放 `Stop`**：目录防污染（`DIR001`）、文档死链（`LNK001`/`LNK002`）、测试契约反作弊（`TST001`~`TST004`）与矩阵不可变列还原（`MTX001`）耗时仅 `~0.6s`，保留在 `Stop` 钩子中按增量指纹触发（干净或已验工作区 `< 15 ms` 放行），绝不启动重型外部类型检查器。
- **重型需在一次大规模改动集成时检查的静态门禁收敛至 `pre-commit`**：`pyright`、`pyrefly`、`ruff`、`eslint`、`prettier`、`tsc` 仅在 `git commit`（`harness hook run --staged`）及显式无参 `harness hook run` 中按变更语言并发执行 **1 次**。
- **机器能确定性拦截的规则移出提示词**：删除 `AGENTS.md` 中的手动静态检查要求，保持 CLI 精简（仅保留 `harness doctor` 与 `harness hook`，不额外扩充检查子命令），违规时由钩子按需注入规则提示。

---

## 2. 方案设计 (Design & Contracts)

### 2.1 门禁分级与跨阶段内容指纹缓存（`<git-dir>/harness-verify-cache.json`）

```mermaid
flowchart LR
    subgraph TurnLoop["单回合工作流与 TDD"]
        Sub["Fresh Subagent 编写红灯测试"] --> Impl["主 Agent 编写实现 & 真实运行验收"]
        Impl --> Commit["git commit (触发 pre-commit)"]
    end

    subgraph PreCommit["Git pre-commit (唯一重型集成门禁)"]
        Commit --> PC["harness hook run --staged"]
        PC --> Concurrent["Promise.all 并发执行:<br/>1. doctor 结构与契约检查<br/>2. 变更感知 pyright/ruff/eslint/prettier/tsc"]
        Concurrent --> PreSign["git write-tree 预签发提交后新树指纹<br/>写入 <git-dir>/harness-verify-cache.json"]
    end

    subgraph StopHook["Agent Stop 钩子 (轻量上下文反作弊护栏)"]
        EndTurn["回合结束 / 异步挂起 (NO_TOOL_CALL)"] --> FastCheck{"只读游标短路 或<br/>工作区干净 / 命中指纹?"}
        FastCheck -- "是 (<15ms)" --> Allow["{\"decision\": \"stop\"}"]
        FastCheck -- "否 (存在未验证脏文件)" --> DoctorOnly["仅执行 doctor + MTX001 自动还原 (~0.6s)<br/>跳过重型 checkStaticTypes"]
        DoctorOnly --> SaveStamp["通过后更新指纹与 lastPassedStepIndex"]
    end
```

1. **物理隔离存储**：通过 `git rev-parse --git-dir` 定向至当前主仓或子 Worktree 专属 Git 目录下的 `harness-verify-cache.json`，不污染工作区，天然隔离并发 Worktree。
2. **工作区内容指纹（`computeWorkspaceDigest`）**：
   - 输入包含：`package.json` 版本号、`.agents/harness.json` 哈希、`git rev-parse HEAD^{tree}`（未提交空仓记为 `"UNBORN"`），以及 `git status --porcelain=v1 -z -uall` 的有序变更覆盖层（存活文件取 `relPath + "\0" + status + "\0" + sha256(bytes)`，删除文件取 `relPath + "\0D"`）。
   - **跨提交树预签发**：当 `harness hook run --staged` 全绿通过且不存在额外未暂存脏修改（`git diff --name-only -z` 为空）时，调用 `git write-tree` 获取提交落盘后的 `nextHeadTree` OID，将 `(nextHeadTree, untrackedOverlay)` 预写入缓存，确保提交完成后紧随其后的 `Stop` 钩子直接命中免检。
   - **显式穿透**：支持 `--no-cache` 参数或 `HARNESS_NO_CACHE=1` 环境变量强制重跑。

### 2.2 `checkStaticTypes` 精确变更门控与并发调度

1. **双变更集合（`getWorkspaceChanges`）**：
   - `allTouchedPaths`：采用 `--diff-filter=ACMRD`（包含 `D` 删除路径）合并未跟踪文件，用于判定是否启动跨文件类型检查器（`pyright`、`pyrefly`、`tsc`），杜绝删除被导入文件时的漏检；
   - `existingChangedFiles`：仅保留磁盘存活文件，传给单文件检查器（`ruff`、`eslint`、`prettier`）；
   - 非 Git 目录返回 `null`，保持全量检查向后兼容。
2. **语言级精确门控**：
   - **`pyright`**：仅当 `allTouchedPaths` 含 `*.py` / `*.pyi` 或 Python 工程配置（`pyproject.toml`、`pyrightconfig.json`、`uv.lock`、`poetry.lock`、`Pipfile.lock`、`requirements*.txt`、`setup.py`、`setup.cfg`）时启动。
   - **`pyrefly`**：满足上述 Python 门控条件，**且仓库显式启用 Pyrefly**（存在 `pyrefly.toml`、`pyproject.toml` 含 `[tool.pyrefly]`、或可执行 `.venv/bin/pyrefly`）时才启动；移除从 `~/.antigravity-ide/extensions/meta.pyrefly-*` 隐式强拉的行为。
   - **`ruff check` / `ruff format --check`**：仅在 `existingChangedPyFiles.length > 0` 或触及 `ruff.toml` / `.ruff.toml` / `pyproject.toml` 时启动；修复无 `.py` 变更时误回退全仓扫描的缺陷。
   - **`eslint`**：仅在 `existingChangedJsTsFiles.length > 0` 或触及 `eslint.config.*` / `.eslintrc*` / `package.json` 时启动；修复无 JS/TS 变更时误扫 `.` 的缺陷。
   - **`prettier --check`**：仅在配置了 Prettier 且对应后缀 `existingChangedFiles` 非空（或 Prettier 配置文件本身变更）时启动。
   - **`tsc --noEmit`**：仅当 `allTouchedPaths` 含 `*.ts` / `*.tsx` / `*.mts` / `*.cts` / `*.js` / `*.jsx` / `*.d.ts` 或触及 `tsconfig*.json` / `jsconfig.json` / `package.json` / 前端锁文件时启动。
3. **异步并发执行**：将 `checkStaticTypes` 内各检查器由阻塞 `spawnSync` 改为异步并发 `Promise.all`，并与 `checkWorkspace` 并行运行。

### 2.3 `Stop` 只读解包与增量游标（`src/hook-tools.js`）

1. **Shell 套壳解包**：`isReadOnlyShellCommand` 支持识别并剥离 `sh`、`bash`、`zsh`、`dash`、`ksh` 搭配无副作用开关（`-c`、`-lc`、`-l`、`-e`、`-u`、`-o pipefail`）包裹的脚本参数，以及 `harness watch ... -- '<cmd>'` 单字符串包裹形式，递归判定内部命令只读性。
2. **协作与调度工具白名单**：`READONLY_TOOL_NAMES` 补充 `send_message`、`schedule`、`define_subagent`；`isReadOnlyToolCall` 补充 `invoke_subagent`（`TypeName === "research"`）与 `swarm`（`action` 为 `"status"` 或 `"models"`）。
3. **失败不逃逸游标 `lastPassedStepIndex`**：仅当 `Stop` 检查通过时更新 `<git-dir>/harness-verify-cache.json` 中的 `{ transcriptPath, lastPassedStepIndex }`；若上一小回合因违规返回 `exit 2` 拦截，游标不推进，防止模型下一小回合仅调用只读工具绕过修复；一旦通过门禁，同轮后续异步唤醒或只读小回合仅扫描游标后的新增步骤。

### 2.4 `harness watch` 原生支持 Heredoc 与 `$SHELL`（`src/watch.js`）

1. **常规文件标准输入直通**：通过 `fs.fstatSync(0).isFile()` 判断 `fd 0` 是否为常规文件（覆盖 `<< 'PY'` Heredoc、`<<< 'str'` 与 `< file` 重定向，此类文件具备有限字节长度，读完必然立即 `EOF`，无交互挂起风险）；为真时 `stdio` 采用 `[0, "pipe", "pipe"]`，否则保持 `["ignore", "pipe", "pipe"]`。
2. **单参数默认 `$SHELL`**：当 `cmdArgs.length === 1` 时，`spawn` 的 `shell` 选项设为 `process.env.SHELL || true`，原生兼容 `zsh` 管道与复合语法。

### 2.5 规范母本修订（`templates/AGENTS.md`）

1. 删除原第 1 节中的“静态与契约检查”手动执行条款。
2. 保留方案 A（所有实质业务改动严格由全新上下文 Fresh Subagent 独立编写测试），并在 TDD 条款中补充：纯解析、转换或规则逻辑优先基于真实静态样本（如 `tests/fixtures/`）或轻量本地资源构造输入，减少非必要的重型外部依赖耗时。

---

## 3. 真实执行与验收标准 (Verification)

- [x] **V1 — `pre-commit` 单点执行与提交后 `Stop` 免检验证**：在 Git 沙盒仓库修改 `.py` 文件并执行 `git add . && git commit`，验证 `pre-commit` 准确运行 1 次 `pyright` + `ruff` + `doctor`；提交完成后紧接着触发 `harness hook run --agent`，验证不启动 `pyright` 且命中缓存快速放行。
- [x] **V2 — `Stop` 钩子不阻塞 TDD 红灯且保留契约反作弊守护**：工作区存在合规测试但底层 `pyright` 报错时，`harness hook run --agent` 直接放行（支持 Fresh Subagent 红灯阶段）；工作区存在 `TST001` / `TST002` 或 `MTX001` 违规时，`harness hook run --agent` 准确拦截并自动还原受保护矩阵不可变列，修复通过后再次触发命中指纹缓存免检放行。
- [x] **V3 — `pre-commit` 非代码提交跳过与删除文件防漏检验证**：仅暂存提交 `README.md` 或 `.yaml` 配置时，`pre-commit` 零次启动 `pyright` / `ruff` / `eslint` / `tsc`；执行 `git rm` 删除 `.py` 模块并暂存提交时，`allTouchedPaths` 捕获 `D` 状态并触发 `pyright` 检出断链错误。
- [x] **V4 — `zsh -c` 只读解包、游标推进与失败防逃逸验证**：在含未提交违规项的工作区执行 `harness watch --timeout 10s -- zsh -c 'git status && rg foo src/ | head -n 5'` 或调用 `send_message` / `research` 子代理时，`Stop` 钩子直接返回 `{"decision":"stop"}`；当上一小回合 `Stop` 因违规返回 `exit 2` 后，下一小回合仅调用 `read_file` 未修复违规时继续拦截不逃逸。
- [x] **V5 — `harness watch` Heredoc 直通与防挂起回归验证**：`zsh` 下执行 `harness watch --timeout 5s -- python3 - << 'PY'` 多行脚本完整读取 `stdin` 并退出 `0`；无文件重定向的交互式 `stdin` 读取仍立即收到 `EOF` 不挂起，全量通过 `watchdog.test.js` 信号级联测试。
- [x] **V6 — 母本同步、架构文档更新与自举全量验收**：更新 `templates/AGENTS.md`（同步至根目录 `AGENTS.md`）与 `docs/architecture/overview.md`，执行 `node ./bin/harness.js run verify-all -- npm test` 与 `node ./bin/harness.js doctor` 全绿通过。
