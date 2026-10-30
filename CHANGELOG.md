# Changelog

本项目的所有重要版本变更、新特性汇总与修复记录均归档于此。

## [Unreleased]

### Added
- 新增测试契约静态巡检规则 `TST001`（拦截 `tests/` 下阶段/序号命名及未归入 `class Test<Subject>:` 的裸测试函数或单词方法名）与 `TST002`（拦截 `unittest.mock`、`MagicMock`、`monkeypatch.setattr`、`jest.mock` 等业务打桩，放行 `monkeypatch.setenv`/`delenv` 并支持 `# harness-ignore CODE: 原因` 豁免）。
- 升级 `src/hook.js` (`harness hook run --agent`)：内置 `terminationReason == "NO_TOOL_CALL"` 正常回合守卫，以及多语言静态类型与 Linter 零容忍检查（自动探测并解析 `.venv/bin/pyright`、`pyrefly`、`ruff`、`eslint`、`tsc` 的错误与警告 JSON）。
- 新增 `harness clean` 命令及 `src/clean.js` 沙盒 TTL / 配额清理模块，并在 `harness hook run` 与 `harness run` 中内置自动过期清理。
- 升级 `AGENTS.md` 与 `PROJECTS.md` 规范母本：确立三要素黑盒测试命名规范，以及 `PROJECTS.md` 与 `docs/adr/` 的职责边界红线。
- 初始化项目 Universal Harness 目录结构与文档规范。
