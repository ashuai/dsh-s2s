# dsh-s2s — DeepSeek Harness 的 Session-to-Session 同宿主会话互联

> **dsh-s2s is a trimmed fork of [`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a) (MIT), specialized for same-host session-to-session interconnection with session-lifecycle and name-first addressing.**

一个 cordis 插件,让**同一台宿主上的多个 DSH session 互相对话**——按**会话名(标题)**点名即可,并支持**拉起已结束(静止)的 session** 参与对话。由 [`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a) 裁剪特化而来。

> 完整使用手册见 [docs/USAGE.md](docs/USAGE.md),踩坑记录见 [docs/LESSONS.md](docs/LESSONS.md),设计(含进程内 broker 修订)见 [docs/SOLUTION.md](docs/SOLUTION.md)。

---

## 鸣谢与出处(Attribution)

本项目基于 **[`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a)** 裁剪而成,遵循 **MIT License**:

- 上游:dpskh/[dsh-a2a](https://github.com/dpskh/dsh-a2a) — 实时 A2A mesh(hub、WebSocket presence、串行注入、不可变消息历史)
- 基线:upstream `main` 快照(2026-08-21 push;核心包 v0.3.0 树)——见 git tag `vendor-base`
- 连接管理、协议与注入核心代码的功劳属于上游作者;本 fork 的增量见下方[裁剪与新增](#裁剪与新增)。

**如果你需要的是跨进程/跨机器的 DSH mesh,请直接使用上游 [`@dpskh/a2a`](https://github.com/dpskh/dsh-a2a)——那是它的主场,也是本项目的上游。**

## 与上游的关系:部署互斥与分工

s2s 是上游的同宿主**特化**,能力天然重叠,因此:

- ⛔ **不要同时挂载两者**。同机同挂会得到双 hub、双工具族(`a2a_*` 与 `s2s_*`)、同一会话双 presence 与重复投递——这是部署冲突,不是功能互补。
- ✅ **分工**:同一台机器内 session 互联(含按名拉起静止会话)→ 用 **s2s**;跨进程/跨机器的 DSH mesh → 用上游 **a2a**。
- ℹ️ 若"外部 agent"指**非 DSH 的标准 A2A 协议实现**(AgentCard / JSON-RPC):上游与本 fork 均不提供该能力,请使用标准协议网关类插件(如 dshfind 上的 `@ryubyte/dsh-a2a`)。

## 定位与范围

| | s2s(本项目) | 上游 @dpskh/a2a |
|---|---|---|
| 拓扑 | **同宿主/单进程,默认 0 端口**(`hub: {}`);跨机需另开 `hub.server` | 跨进程/跨机(可信局域网) |
| 会话生命周期 | ✅ 按名**拉起**(resume)静止会话 | ❌ 仅在线接收方 |
| 防回环/预算 | ✅ 发送侧 hop/限速 | ❌ |
| 命名寻址 | ✅ **name(标题)主寻址,现读不缓存** | ❌(仅 roster/去重) |
| 浏览器协作 UI / 命令面 | ❌ 已裁剪 | ✅ |
| 协议内核 | 与上游同源(mesh protocol v3) | 同左 |

## 功能一览

- **name(标题)主寻址**:`s2s_resume(name: "开发", ...)` 直接点名;**每次现读会话最新标题**,你随时改名即刻生效;同名报 `ambiguous`(用 `session_id` 消歧),查无报 `not-found` + 候选列表。
- **拉起静止会话**:`AgentRegistry.resume` 写入 → `agent.followup`(空闲)/`inject`(忙碌)投递;拉起的会话留在 live-idle(不自动归眠)。
- **5 个模型工具**:`s2s_peers` / `s2s_message` / `s2s_history` / `s2s_sessions`(含标题+三态) / `s2s_resume`(按名/按 id)。
- **持久信箱**:`~/.dsh/s2s/mailboxes/<sessionId>/*.json`,原子写、时序命名、损坏自愈。
- **按需加载**:`hub`/`mesh`/`lifecycle`/`budget` 配置块缺席即不挂载。

> 唤醒流程与配置字段见 [docs/USAGE.md](docs/USAGE.md)(重点:`autoResume: allow` 才真正拉起)。

## 裁剪与保留

**保留(上游功劳)**:mesh 客户端(串行注入 `followup/inject`、`persistConnections`、退避重连)、hub 全套(注册表/不可变历史/presence/协议 v3)、消息附件机制、错误分类与 invariant 体系、vitest 套件。`view.ts`/`activity.ts` 保留——mesh 核心直接依赖,非外接面。

**裁剪**:命令面(`commands.ts`)、浏览器测试替身(`test/` stubs)、`ui-a2a` 浏览器包(不随 fork)。`/s2s` 命令也随命令面移除;live 多会话 join 依赖工具直连与 future broker。

**新增(s2s 增量)**:`mailbox.ts`、`lifecycle.ts`(resume 拉起)、`discovery.ts`(live+dormant 合并现读标题)、`budget.ts`;以及 name-寻址解析。

## 路线图(Roadmap)

- **R0 ✅** vendor 导入(`vendor-base` tag)、出处与鸣谢。
- **R1 ✅** 品牌与裁剪(包名 `dsh-s2s`/0.3.0-s2s.0、插件 id、`ctx.s2sHub/s2sMesh`、工具改名)。
- **R2 ✅** 生命周期(mailbox + resume 拉起 + drain + 防双开 + 授权闸);**name 主寻址**已并入(现读标题)。
- **R3 ▲** 预算(hop/限速)✅ 随 R2 落地;`s2s-etiquette` skill 待做。
- **R4 ▲** 稳定发布:`0.3.0-s2s.0` tag 已打,挂载文档/USAGE 已就位;真实 GUI 端到端体验待部署环境确认(生效方式随部署环境热替换策略而别)。
- **R5(设计已定格,待实现)** 同宿主改走**进程内 `S2sBroker`**(直取 `ctx.agents`,零端口/零 WS),hub 服务降为进程内可选跨机扩展——详见 [docs/SOLUTION.md §R5](docs/SOLUTION.md)。

## 状态

**typecheck 0 错 + vitest 10 文件 70/70 全绿;`pnpm run build` 产出 `lib/index.js`。** 挂载形态见 [`cordis.patch.yml`](cordis.patch.yml)(insert 形式 + ESM 入口)与 [docs/USAGE.md](docs/USAGE.md);`autoResume: allow` 开启按名拉起。

> 说明:插件改动(配置/重建 lib)的生效方式取决于所在部署环境的热替换策略;请结合部署环境的文档确认。

## 开发

```sh
pnpm install
pnpm run typecheck     # 0 错
pnpm run test          # 70/70
pnpm run build         # 产出 lib/index.js
```

## License

MIT。上游版权与许可文件保留于 [`LICENSE`](LICENSE);本 fork 的修改同样以 MIT 发布。