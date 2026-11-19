# 上下文与模块边界 (Architecture Overview)

> 本文件维护静态模块边界与源码入口地图（C4 L1–L2）。动态链路、领域模型与系统不变量请分别维护在 [data-flow.md](data-flow.md)、[data-model.md](data-model.md) 与 [invariants.md](invariants.md) 中。

## 1. 系统上下文与模块依赖拓扑

```mermaid
flowchart LR
    External["外部依赖 / 调用方"] --> Entry["入口层"]
    Entry --> Core["核心模块"]
```

## 2. 模块职责与源码入口地图

- **入口层**：<!-- 链接到真实源码路径，一句话说明管什么、不管什么 -->
- **核心模块**：<!-- 链接到真实源码路径，一句话说明管什么、不管什么 -->
