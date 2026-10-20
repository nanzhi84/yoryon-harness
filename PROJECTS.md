# PROJECTS.md

本仓库是个人通用 Agent Harness（`yoryon-harness`）的母本与 CLI 实现仓库，自身采用同一套规范进行自举。

- **运行时约束**：Node.js (`>= 18`) 原生 ESM，零第三方运行时依赖，确保任何环境可直接通过 `npm link` 或 `npx` 运行。
- **母本同步红线**：修改 [templates/AGENTS.md](templates/AGENTS.md) 或 [templates/docs/README.md](templates/docs/README.md) 后，必须运行 `node ./bin/harness.js sync` 将通用规则同步回本仓库根目录。
- **架构与源码入口**：详见 [docs/architecture/overview.md](docs/architecture/overview.md)。
- **自验要求**：对 CLI 的任何实质改动，需执行 `node ./bin/harness.js run verify-all -- npm test` 并通过 `node ./bin/harness.js doctor`。
