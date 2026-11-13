# 全局架构现状 (Architecture Overview)

## 1. 模块边界与源码地图

`yoryon-harness` 由**静态模板母本（`templates/`）**与**零依赖运行时 CLI（`bin/` + `src/`）**两部分组成：

```mermaid
flowchart TD
    CLI["bin/harness.js (CLI 路由入口)"] --> Init["src/init.js (骨架注入与同步)"]
    CLI --> Doctor["src/doctor.js (结构、测试、矩阵、架构与死链巡检)"]
    CLI --> Hook["src/hook.js (Agent 与 Git 自动钩子)"]
    CLI --> Watch["src/watch.js (命令超时、静默检测与死循环熔断看门狗)"]
    CLI --> Clean["src/clean.js (沙盒 TTL、Worktree GC 与共享路径软链)"]
    CLI --> Run["src/run.js (隔离沙盒执行)"]
    CLI --> Scaffold["src/scaffold.js (Spec & ADR 流转)"]

    Config[".agents/harness.json (声明式机器配置)"] --> Doctor
    Config --> Hook
    Config --> Clean

    Init --> Tpl["templates/ (标准骨架母本)"]
    Hook --> Clean
    Hook --> Doctor
    Hook --> Watch
    Hook --> HookScript["src/hook-script.js (受管脚本片段迁移)"]
    Hook --> Tools["src/hook-tools.js (工具探测、PATH 与变更文件)"]
    Hook --> TypeCheck["src/hook-checks.js: checkStaticTypes (Pyright / Pyrefly / Ruff / ESLint / Prettier / TSC 零容忍检查)"]
    Run --> Clean
    Run --> Watch
    Doctor --> Rules["自研巡检规则 (HAR/DIR/GIT/ARC/SPC/ADR/REF/LNK/VOX/SUP/TST/MTX/AST)"]
    Run --> Sandbox["work/<run-id>/ & artifacts/<run-id>/"]
    Clean --> Sandbox
```

- [bin/harness.js](../../bin/harness.js)：CLI 命令解析与子命令分发路由，不包含具体文件系统状态修改逻辑。
- [src/init.js](../../src/init.js)：负责 `harness init` 与 `harness sync`，从 [templates/](../../templates) 读取母本并向目标仓库写入目录、通用规范及 Git / `.agents/hooks.json` 守护钩子。
- [src/doctor.js](../../src/doctor.js)：负责 `harness doctor` 与 `harness rule`，结合 `git ls-files -co --exclude-standard` 动态感知忽略规则，执行目录契约与防污染白名单（`HAR001`/`DIR001`）、生命周期位置（`SPC001`/`ADR001`/`ADR002`）、三列索引（`REF001`）、多语言测试命名与反 Mock/超时/只读基线锁契约（`TST001`~`TST004`）、矩阵不可变列保护（`MTX001`）、声明式架构边界守卫（`AST001`/`AST002`）及 Markdown 本地死链/锚点检查（`LNK001`/`LNK002`）。
- [src/hook-script.js](../../src/hook-script.js)：按起止标记替换受管片段，旧版持久化 hook 仅按已发布格式迁移；未知旧片段拒绝覆盖，原文件保持不变。用户前后脚本逐字节保留。
- [src/hook-tools.js](../../src/hook-tools.js) 与 [src/hook-checks.js](../../src/hook-checks.js)：分别封装多语言工具探测、变更路径双集发现（存活变更文件与含删除路径的 `allTouchedPaths`）、`<git-dir>/harness-verify-cache.json` 内容寻址指纹与 `Stop` 游标缓存、Shell `-c` 套壳与协作工具只读解包，以及按语言变更门控并发调度的静态检查流程。
- [src/hook.js](../../src/hook.js)：负责 `harness hook install`、`harness hook pre-tool` 与 `harness hook run [--agent] [--staged] [--no-cache] [--full]`，自动归一化多语言工具链 `PATH`（`.venv/bin`、`node_modules/.bin`、`~/.cargo/bin`、`~/.local/bin`），自动配置本地 `git config --local fetch.prune true` 并通过 `gh repo edit <owner>/<repo> --delete-branch-on-merge` 自动开启 GitHub 远端 PR 分支自动删除（未关联 GitHub 或 `gh` 失败时输出提醒且不阻塞本地命令），通过 Agent `PreToolUse` 钩子强制拦截未包裹 `harness watch --timeout <duration> -- <cmd>` 的裸命令与 `while true` 死循环轮询；将门禁按职责分为两级——Agent `Stop` 钩子仅对新增未验证脏文件执行轻量结构/契约巡检与 `MTX001` 不可变单元格自动还原（跳过重型外部类型检查器，支持 TDD 红灯阶段与毫秒级指纹/只读短路），Git `pre-commit`（`--staged`）并行执行 `doctor` 与变更感知的静态类型/Linter/格式化检查（Pyright/显式配置的 Pyrefly/Ruff/ESLint/Prettier/TSC）并通过 `git write-tree` 预签发提交后新树指纹以消除跨阶段重复扫描。
- [src/watch.js](../../src/watch.js)：负责 `harness watch --timeout <duration> [--idle-timeout 5m] [--max-repeat 100] [--tty | --no-tty] -- <cmd>`，提供进程组级总时长硬超时（`WALL_TIMEOUT`）、默认 5 分钟静默挂起熔断（`IDLE_TIMEOUT`）、默认连续 100 行相同输出死循环刷屏熔断（`LOOP_DETECTED`，同时识别并豁免裸 `\r` 及光标移动/擦除原地重绘帧以防止误杀进度条）、外层非 `dumb` 真终端自动透传 `TTY_COMPATIBLE=1` 与终端宽高、显式 `--tty` 下非终端管道的原地重绘帧内容去重与 10 秒时间窗口节流（并在普通输出前或子进程结束时补刷最新一帧）、常规文件 `fd 0`（Heredoc / `< file`）标准输入直通与交互式 `stdin` 关闭保护、单字符串命令 `$SHELL` 执行，以及宿主 `SIGTERM` / `SIGINT` / `SIGHUP` 向独立子进程组（`-child.pid`）级联转发与宽限期 `SIGKILL` 兜底回收。
- [src/clean.js](../../src/clean.js)：负责 `harness clean`（含 `--worktrees`）及生命周期钩子触发的 `work/`、`artifacts/` 中间产物 TTL / 数量配额清理，基于 `.agents/harness.json` `worktreeSharedPaths` 在子 worktree 中自动软链主仓共享路径，以及基于 `<common_git_dir>/worktrees/*/gitdir`、`.git/index.lock` 锁探活与 mtime 冷却窗口的孤儿 worktree 空壳目录、`.git/worktrees/` 悬空元数据、已合并或上游远端已删除（`[gone]`）的本地分支与干净子 worktree、项目环境注册表失效 `environments` 条目回收。
- [src/run.js](../../src/run.js)：负责 `harness run`，接管验收命令的隔离沙盒目录创建、子 worktree 共享路径自动软链、工具链环境变量注入与回执落盘。
- [src/scaffold.js](../../src/scaffold.js)：负责 `harness spec new`、`harness adr new` 与 `harness adr supersede` 的确定性文档流转。

## 2. 核心执行链路与数据流

```mermaid
sequenceDiagram
    participant Agent as Agent / 开发者
    participant CLI as bin/harness.js
    participant FS as 目标仓库文件系统
    participant Sandbox as work/ & artifacts/

    Agent->>CLI: harness init / sync
    CLI->>FS: 创建目录骨架、同步 AGENTS.md & docs/README.md、配置 .agents/hooks.json
    Agent->>CLI: harness spec new / adr new / adr supersede
    CLI->>FS: 生成 issue#<N>/spec.md 或流转 ADR 至 superseded/
    Agent->>CLI: harness run <task> -- <cmd>
    CLI->>Sandbox: 软链 worktreeSharedPaths，创建 <run-id> 隔离目录，执行命令并落盘 receipt.json
    Agent->>CLI: harness doctor / hook run
    CLI->>FS: 扫描目录白名单、多语言测试契约、只读基线锁、矩阵不可变列、架构边界与增量类型/格式检查
```

## 3. 系统不变量与边界约束

1. **非破坏性初始化与同步（[`src/init.js`](../../src/init.js)）**：
   - `harness init` 在未传 `--force` 时，严禁覆盖目标仓库已有的任何文件；`.gitignore` 采用按行去重追加策略确保 `work/` 与 `artifacts/` 被忽略。
   - `harness sync` 仅覆盖更新通用协议文件（`AGENTS.md` 与 `docs/README.md`）并同步确保 `.git/hooks/` 与 `.agents/hooks.json` 守护钩子就绪，绝不触碰项目特异文件（`README.md`、`PROJECTS.md`、`CHANGELOG.md`、`docs/architecture/`、`docs/reference/INDEX.md`、`.agents/harness.json`）。
2. **结构、反作弊与架构完备性（[`src/doctor.js`](../../src/doctor.js)）**：
   - `DIR001`：`docs/` 下严格只允许 `README.md` 及 5 个标准子目录（`architecture/`、`spec/`、`adr/`、`runbooks/`、`reference/`）；仓库根目录严禁散落未授权二进制截图、压缩包或临时脚本。默认根目录仅保留 `.git`、`.agents`、`bin`、`src`、`docs`、`tests`、`work`、`artifacts`、`experiments`、`dist`；项目、框架及编辑器目录必须在 `.agents/harness.json` 的 `rootAllowlist` 中显式声明（支持名称和 glob），不由核心代码预置技术栈。根目录检查仍遵循 Git 忽略规则；递归内容扫描的依赖/缓存排除名单不构成根目录放行权限。`worktreeSharedPaths` 作为项目显式共享路径声明继续放行对应顶层目录。文件白名单与 `docs/` 子目录规则不变。
   - `SPC001`、`ADR001` / `ADR002`、`REF001`、`LNK001` / `LNK002`：强制保证 Spec/ADR 生命周期位置、参考资料索引登记与本地链接/锚点精确匹配。
   - `TST001` ~ `TST004`：`tests/` 下严禁阶段/序号命名测试文件，Python（`class Test<Subject>:` + `def test_<scenario>_<expected>()`）与 TS/JS（`describe("Test<Subject>", ...)` + `it("test_<scenario>_<expected>", ...)`）对称强制层级与两段式命名；严禁业务 Mock（`TST002`）；锁定 `.agents/harness.json` `protectedPaths` 只读裁判基线（`TST003`）；强制测试内 `subprocess.run` / `spawnSync` / `execSync` 显式传入 `timeout`（`TST004`）。
   - `MTX001`、`AST001` / `AST002`：按 `.agents/harness.json` 锁定 CSV/TSV `immutableColumns` 不可篡改，以及声明式分层依赖方向与核心目录禁用字面量正则。
3. **门禁职责分级、跨阶段指纹去重与变更感知静态门禁（[`src/hook.js`](../../src/hook.js)、[`src/hook-tools.js`](../../src/hook-tools.js) & [`src/hook-checks.js`](../../src/hook-checks.js)）**：
   - `harness hook run --agent`（`Stop` 钩子）仅在正常回合结束（`terminationReason == "NO_TOOL_CALL"`）时运行轻量上下文契约与反作弊守护（`doctor` + `MTX001` 自动从 `HEAD` 还原不可变列单元格 + 沙盒清理，**不启动重型外部类型检查器**以免阻塞 TDD 红灯阶段与半成品交互）；若基于 `lastPassedStepIndex` 游标及 `sh/bash/zsh -c` 解包判定当前新增步骤仅含只读/调度操作，或工作区内容摘要命中 `<git-dir>/harness-verify-cache.json`，直接输出 `{"decision":"stop"}` 放行。
   - `harness hook run --staged`（Git `pre-commit` 钩子）并行执行 `doctor` 与按 `allTouchedPaths`（含删除路径 `D`）精确门控的并发静态检查（Pyright、显式配置的 Pyrefly、Ruff、Ruff Format、ESLint、Prettier、TSC），并在无额外未暂存修改时通过 `git write-tree` 预签发提交后新树指纹，实现跨阶段单次执行零冗余。
4. **隔离沙盒运行与回执落盘（[`src/run.js`](../../src/run.js)）**：
   - `harness run` 在 `work/<run-id>/` 与 `artifacts/<run-id>/` 隔离目录中执行验收命令并生成 `receipt.json` 审计回执。
5. **Worktree 物理目录回收边界、分支合并校验与并发活跃度守卫（[`src/clean.js`](../../src/clean.js)）**：
   - 回收失效 worktree 前强制检查 `.git/index.lock` 等锁文件与 mtime 冷却窗口，且仅允许删除严格位于 `worktreeContainerDirs` 容器内部且无有效 `.git` 链接的物理目录；对上游远端已删除（`[gone]`）的本地分支与关联干净 worktree，强制通过 `git for-each-ref --merged` 或 `git merge-tree --write-tree` 校验分支改动已合入主分支后才允许移除，防止未合并本地提交丢失引用。
