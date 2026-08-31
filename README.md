# dsh-s2s — DeepSeek Harness 的 Session-to-Session 同宿主会话互联

> **dsh-s2s is a trimmed fork of [`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a) (MIT), specialized for same-host session-to-session interconnection with session-lifecycle support.**

一个 cordis 插件,让**同一台宿主上的多个 DSH session 互相对话**——并支持**拉起已结束(静止)的 session** 参与对话。由 [`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a) 裁剪特化而来。

---

## 鸣谢与出处(Attribution)

本项目基于 **[`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a)** 裁剪而成,遵循 **MIT License**:

- 上游:dpskh/[dsh-a2a](https://github.com/dpskh/dsh-a2a) — 实时 A2A mesh(hub、WebSocket presence、串行注入、不可变消息历史)
- 基线:upstream `main` 快照(2026-08-21 push;核心包 v0.3.0 树)——见 git tag `vendor-base`
- 全部连接管理、协议与注入核心代码的功劳属于上游作者;本 fork 的增量见下方[裁剪与新增](#裁剪与新增)。

**如果你需要的是跨进程/跨机器的 DSH mesh,请直接使用上游 [`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a)——那是它的主场,也是本项目的上游。**

## 与上游的关系:部署互斥与分工

s2s 是上游的同宿主**特化**,能力天然重叠,因此:

- ⛔ **不要同时挂载两者**。同机同挂会得到双 hub、双工具族(`a2a_*` 与 `s2s_*`)、同一会话双 presence 与重复投递——这是部署冲突,不是功能互补。
- ✅ **分工**:同一台机器内 session 互联(含拉起静止会话)→ 用 **s2s**;跨进程/跨机器的 DSH mesh → 用上游 **a2a**。
- ℹ️ 若"外部 agent"指**非 DSH 的标准 A2A 协议实现**(AgentCard / JSON-RPC):上游与本 fork 均不提供该能力,请使用标准协议网关类插件(如 dshfind 上的 `@ryubyte/dsh-a2a`)。

## 定位与范围

| | s2s(本项目) | 上游 @dpskh/a2a |
|---|---|---|
| 拓扑 | **同宿主**(单进程优先;hub 监听代码保留、默认不开) | 跨进程/跨机(可信局域网) |
| 会话生命周期 | ✅ 静止(done)session 可被拉起参与对话(路线图 R2) | ❌ 仅在线接收方 |
| 防回环/预算 | ✅ 发送侧 hop/限速(路线图 R3) | ❌ |
| 浏览器协作 UI / 命令面 | ❌ 已裁剪 | ✅ |
| 协议内核 | 与上游同源(mesh protocol v3) | 同左 |

## 裁剪与新增

**保留(上游功劳)**:mesh 客户端(串行注入 `followup/inject`、`persistConnections`、退避重连)、hub 全套(注册表/不可变历史/presence/协议 v3)、3 个模型工具、消息附件机制(协议组成部分,按需使用)、错误分类与 invariant 体系、vitest 测试套件。

**裁剪**:命令面(`commands.ts`)、浏览器测试替身(`test/` stubs)与 `ui-a2a` 浏览器包(不随 fork);`view.ts`/`activity.ts` 保留——它们是 mesh 核心直接依赖的内部件(活动跟踪与类型),不是外接面。

**新增(s2s 增量)**:`mailbox.ts` 静止会话信箱、`lifecycle.ts` 经 `AgentRegistry.resume` 拉起 + `agent.followup` 投递 + 授权闸、`budget.ts` 发送侧防回环预算。

## 路线图(Roadmap)

- **R0 ✅ vendor 导入**:上游快照入库(`vendor-base` tag),出处与鸣谢就位。
- **R1 品牌与裁剪**:包名 `dsh-s2s`、插件 id、`ctx.s2sHub`/`s2sMesh`、工具改名 `s2s_peers / s2s_message / s2s_history`;按上表裁剪;patch 默认纯 in-process(不开 hub 监听)。
- **R2 生命周期(核心增量)**:静止会话信箱;`AgentRegistry.resume` 拉起(`agent/created` → drain → `agent.followup` 投递);防双开;拉起授权闸(同 workspace 直达、跨 workspace 询问);拉起后默认留在 live-idle。
- **R3 预算与礼仪**:hop 上限/对间限速(发送侧强制);`s2s-etiquette` skill。
- **R4 稳定发布**:vitest 全绿、`0.3.0-s2s.0` tag、挂载文档。
- **远期可选**:离线信箱上移 hub 侧(storage 域);与外部标准 A2A agent 互通(评估独立网关,不在本包内做)。

## 状态

**重构中(R0→R1 之间)**:当前树 = 上游基线 + 本 README;R1 起代码面才体现 s2s 命名与裁剪。上游用法在 R1 前仍然有效(见 `REPOSITORY.md` 与 `cordis.patch.yml`)。

## 开发

```sh
pnpm install
pnpm run typecheck:all
pnpm run test
```

测试沿用上游 vitest 套件(R1 起随裁剪同步增删;新增生命周期模块将补专属 spec)。

## License

MIT。上游版权与许可文件保留于 [`LICENSE`](LICENSE);本 fork 的修改同样以 MIT 发布。
