# 核心领域模型与状态机 (Data Model & State)

> 本文件描述 `yoryon-harness` 的核心配置/回执/缓存实体关系，以及 ADR 与 Worktree 的核心生命周期状态机。

## 1. 核心配置与运行时产物关系

```mermaid
erDiagram
    HARNESS_CONFIG ||--o{ DOCTOR_DIAGNOSTIC : "configures"
    HARNESS_CONFIG ||--o{ WORKTREE_LINK : "worktreeSharedPaths"
    SANDBOX_RUN ||--|| RECEIPT_JSON : "writes"
    GIT_REPO ||--o| VERIFY_CACHE : "stores in git-dir"
    VERIFY_CACHE ||--o{ HOOK_EXECUTION : "short-circuits"
```

## 2. 关键生命周期状态机

### 2.1 ADR 文档生命周期（[src/scaffold.js](../../src/scaffold.js)、[src/doctor.js](../../src/doctor.js)）

```mermaid
stateDiagram-v2
    [*] --> Active: harness adr new (docs/adr/NNNN-slug.md)
    Active --> Superseded: harness adr supersede (更新头部状态 + 底部失效说明 + 移入 docs/adr/superseded/)
    Superseded --> [*]
```

### 2.2 门禁缓存与分支/Worktree 回收状态（[src/hook.js](../../src/hook.js)、[src/clean.js](../../src/clean.js)）

```mermaid
stateDiagram-v2
    [*] --> Dirty: 工作区/暂存区变更
    Dirty --> StopVerified: Stop 钩子通过 doctor + MTX001
    Dirty --> CommitVerified: pre-commit 通过 doctor + 静态检查并预签发树指纹
    StopVerified --> CommitVerified: git commit
    CommitVerified --> [*]: 后续只读回合命中指纹直接放行
```

## 3. 权威结构与配置索引

- **项目声明式配置（`.agents/harness.json`）**：读取与默认合并逻辑见 [src/doctor.js](../../src/doctor.js)（`loadHarnessConfig`）及 [src/clean.js](../../src/clean.js)。
- **诊断条目与规则表（`RULES` / `addDiag`）**：定义于 [src/doctor.js](../../src/doctor.js)。
- **沙盒执行回执（`receipt.json`）**：构造与落盘逻辑见 [src/run.js](../../src/run.js)。
- **跨阶段验证缓存（`<git-dir>/harness-verify-cache.json`）**：读写与指纹计算见 [src/hook-tools.js](../../src/hook-tools.js)。
