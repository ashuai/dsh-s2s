# dsh-s2s — Session-to-Session 同宿主会话互联 · 解决方案(v0.2,供评审)

> **文档定位:本文件是 v0.2 的设计/证据稿(历史基线)**。设计与证据核对结论仍有效,但其中「未写任何代码」「评审后实施」等表述已过时——**实现已完成**,现行状态、功能、用法与挂载方式以 [README](../README.md) 与 [docs/USAGE.md](USAGE.md) 为准。
> v0.2 变更:① 更名 **dsh-a2a → dsh-s2s**(理由见 D1);② 新增 §0.5 对第三方插件 `@dpskh/a2a` 的评估结论与分工方案(hybrid)。
> 证据基础:对本机已安装 DSH 发布包(全局 node_modules 下的 `@deepseek-ai/*`)的类型面与文档逐一核对;每条结论标注【已验证】/【待验证】——**其中的路径/端口/本机插件名仅在证据核对时成立,不构成可移植结论**。

---

## 0. TL;DR 与决策点

**一句话**:同宿主 session 互联(s2s)= 一个宿主侧 cordis 插件(注册表 + 传输 + 3 个模型工具)+ 一个纯提示侧礼仪 skill。与对外的 a2a mesh(如 `@dpskh/a2a`)是**两个层次**,可叠加,不互斥。

| # | 决策点 | 选项 | 建议/状态 |
|---|--------|------|-----------|
| D1 | 插件命名 | ~~dsh-a2a~~ vs ~~session2a~~ vs s2s | **已拍板(2026-08-31):dsh-s2s**。理由:① 语义准确——本方案的当事方是 **session**(有日志、cwd、resume 生命周期),不是泛化的网络 agent;② **与 `@dpskh/dsh-a2a` 重名冲突**(其已在 dshfind 发布,包名就叫 dsh-a2a);③ 与"对外 a2a"划清边界(见 §0.5)。工具名随 D2 改为 s2s_* |
| D2 | 工具命名 | ~~a2a_~~_* vs peer_* vs **s2s_*** | 随 D1:`s2s_list / s2s_send / s2s_inbox`(+hybrid 下补 `s2s_resume`) |
| D3 | 对方 busy 时投递 | 插当前 step 边界(steering 语义) vs 排队下一 turn | **排队 nextTurn 为默认**,step 插话仅当发送方显式 `urgent`(@dpskh 的"忙碌→纯上下文"与此一致,互为印证) |
| D4 | 静止 session 投递 | v1 就做(M3) vs 缓到 v2 | v1 做——这是 s2s 相对 a2a 的**核心增量** |
| D5 | 全自动多轮往返 | 默认开 vs 默认关 | **默认关**(单次 request→reply),连续对话需 config 显式开启;防失控与 token 失血 |
| D6 | 拉起静止(done)session 的授权与善后 | 直接拉起 vs 每次人类确认;拉起后自动归眠 vs 留在 live-idle | **同 workspace 直接拉起、跨 workspace 需确认;拉起后默认留在 live-idle 不自动归眠**(GUI 立即可见,人类可旁观/接管) |

## 0.5 v0.2 评估:@dpskh/a2a 与本插件的分工(hybrid)

**定性**:`@dpskh/a2a`(v0.3,dshfind 分发,npm 上无此包)做的是**对外/跨边界的实时 presence mesh**——hub+WebSocket+storage 域+UI,participant 抽象是"持有 socket 的任意 agent",**生命周期盲**(presence 存在当且仅当 socket 存活,无离线投递、无 roster 持久化)。本方案做的是**宿主内的 session 生命周期互联**——当事方是 DSH session 本身(注册表真相、日志、mailbox、`AgentRegistry.resume` 拉起)。s2s 之名即为此区分。

| 能力 | @dpskh/a2a | dsh-s2s(本方案) |
|---|---|---|
| live session 互聊(跨项目/跨进程/跨机) | ✅(强项) | v1 仅单宿主 |
| **拉起静止(done)session** | ❌ 已知限制第 1 条 | ✅ M3 主线 |
| 防回环/预算 | ❌ 无 | ✅ §4.5 |
| 附件/历史回顾/连接图 UI | ✅(强项) | 不做 |
| 部署重量 | storage 三件套+独立端口+双包 | 零依赖薄插件 |

**结论(hybrid)**:
1. **live 层直接采用 `@dpskh/a2a`**,顶替原 M1(发现)与 M2(live 环)——不自研;其"空闲→后续 turn、忙碌→纯上下文"的串行注入与本方案 D3 语义一致(独立收敛,方向互证)。
2. **本插件收窄为 delta**:`s2s_resume`/拉起静止 session + mailbox + 授权闸(M3 升为主线);礼仪 skill(M4)。
3. 可选增强:resume 后的会话经其 `persistConnections` 自动回归 presence,信件改走 mesh 投递,两套注入器对齐。

**采用前置检查(6 项)**:① 源码审查(它持 `ctx.agents`/storage/会话注入全部宿主权力,且 npm 无包、仅 dshfind 分发——挂载即供应链信任);② busy"纯上下文"注入的实际语义;③ storage 三件套路由配置成本;④ `persistConnections` 对 GUI 动态 session id 的实际重连行为;⑤ 信任模型:hub 端点**不认证**(默认 `127.0.0.1:<hub-port>`),宿主机任意进程可注入指令进 agent 会话——单用户开发环境可接受但须有意识接受;⑥ license 与维护状态。

---

## 1. 目标与非目标

**目标**
- G1 同一宿主上任意两个**活着**的 session 可互发消息并获得回信(双向、可持续多轮)。
- G2 **静止(done)session 可被程序化拉起**:收到信件时经 `AgentRegistry.resume` 自动复活为 live agent 并处理,人类可在 GUI 旁观全程。
- G3 全程人类可见:往来消息以一等公民身份落双方 session 事件日志,GUI 直接渲染,无黑箱。
- G4 防回环、有预算、可审计(hop/预算字段随信走,全部落盘)。

**非目标**
- 跨机器/跨宿主通信(那是对外 a2a mesh 的职责,见 §0.5;hybrid 下天然获得)。
- 替代 subagent/workflow(树内委托仍是 session 内快捷路径,s2s 服务于**平级独立 session**)。
- 修改 DSH 核心或 fork 官方包(纯 profile 插件,卸载即恢复原状)。

---

## 2. 证据基础(代码考古)

| s2s 需要的能力 | DSH 原语 | 所在包 | 状态 |
|---|---|---|---|
| live agent 注册表 | `ctx.agents: AgentRegistry`("tracks live agents / all live top-level agents") | dsh-agent | 【已验证】类型面 |
| **送达原语** | `Inbox.append/prepend/splice(target, msg)`——"durably record the insertion",先落 `agent/inbox/spliced` 事件再改活投影;分 `nextTurn`(等独立 turn)与 `nextStep`(等 step 边界)两条队列 | dsh-agent/`inbox` | 【已验证】类型面;宿主侧从 AgentRegistry 句柄拿到目标 Inbox 的公开路径见 OQ-1 |
| 消息身份标注 | `MessageSourceMap` 注释明写 "Merge-extensible sum type — plugins add their own kinds",且内置 `{ kind:'plugin', plugin:string }` | dsh-llm | 【已验证】 |
| session 发现(含静止) | `session-query-sqlite`(web bundle 已挂载);`session-reference.listCandidates()` 按 cwd 亲和排序 | dsh-session-query-sqlite / dsh-session-reference | 【已验证】已挂载/类型面 |
| **静止 session 拉起** | `AgentRegistry.resume(ownerCtx, { resumeSessionId })`:"Prepare a persisted session and resume an agent on it"——经 `sessionPersistence.prepare` 重放日志 → 发布 agent/session → 启动 loop;返回 `AgentHandle{agent, dispose}`,dispose 能力归调用者;dsh-agent-loop 已实现(`identity.resume ? { resumeSessionId }`);重复身份双开被拒("duplicate exact session identity") | dsh-agent / dsh-agent-loop | 【已验证】类型面+实现 |
| 非人类唤醒先例 | `dsh-schedule`:定时派发驱动 live root agent 跑 turn | dsh-schedule | 【已验证】README+实现 |
| 权限围栏先例 | `dsh-jobs`:owner-session 围栏、跨 owner 不可见不可收 | dsh-jobs | 【已验证】README |
| 插件挂载点 | profile 目录下的 `cordis.patch.yml` 用户 patch 层(本机示例:一个已有的本地用户插件,先用 `insert:` 形式装载);`ctx.webServer.register(route)` 可在宿主 web 端口注册 HTTP 路由 | cordis / dsh-host-webserver | 【已验证】 |
| 事件词汇预留 | persistence catalog 已含 `team/member`、`team/message/queued`、`team/message/delivered`、`team/task` | dsh-session | 【已验证】(上游已向多 agent 语义演进;本方案 v1 不依赖,用 user/message + plugin 来源) |
| 不可行项佐证 | 无 `tool-cordis`、无 `schedule` 工具挂载于本部署;headless 是"新建一次性 agent"而非接续指定 session | dsh-base patch / dsh-headless | 【已验证】(否决纯 skill 路线的依据) |

---

## 3. 总体架构

```
        ┌─────────────────────────── 宿主进程(单 GUI, 127.0.0.1:<port>)───────────────────────────┐
        │                                                                                       │
        │   Session A(agent)                     Session B(agent)               Session C(静止)  │
        │      │  ▲   ▲                                 │  ▲   ▲                                │
        │      │  │   │ 回信自动回流                      │  │   │                                │
        │      ▼  │   └────────────┐          ┌────────┘  │   │                                │
        │   [s2s_send] [s2s_inbox] │          │  [s2s_send][s2s_inbox]                      │
        │      │                   │          │      │                                      │
        │      ▼                   ▼          ▼      ▼                                      │
        │  ┌──────────────────────── dsh-s2s 插件(cordis)──────────────────────────────┐       │
        │  │ ① s2s-registry:liveness 真相(live=ctx.agents / 静止=事件日志扫描)           │       │
        │  │ ② s2s-transport:送达=目标 Inbox.append;静止=mailbox+resume 拉起;回信=反向   │       │
        │  │ ③ tools:s2s_list / s2s_send / s2s_inbox(仅这 3 个进模型工具面)              │       │
        │  └──────────────────────────────────────────────────────────────────────┘       │
        │        │                                            │                                          │
        │        ▼                                            ▼                                          │
        │   Inbox.append(B.nextTurn,                     resume(C) → mailbox drain                        │
        │     user/message, source=plugin:dsh-s2s)       → 信件 splice 进 nextTurn                        │
        └───────────────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼  全部落双方 session.jsonl.zstd(user/message 表面事件)→ GUI 可见、可回放
```

(hybrid 模式下,①/② 的 live 半环可替换为 @dpskh/a2a 的 hub+presence,本图示自研全栈形态。)

**数据流(以 A→B 为例)**
1. A 调 `s2s_send {to:B, body, expect:"reply"}` → 插件校验预算/权限,封装 envelope。
2. 查 registry:B live?→ 取 B 的 Inbox,`append(nextTurn, envelopeAsUserMessage)`(B busy 且 urgent 时才用 nextStep,默认排队)。B 静止?→ 写 mailbox 文件,返回 `delivered:"queued-dormant"`。
3. B 的 agent loop 在下个 turn 边界 claim 该消息(与 GUI steering 同一消费路径)→ B 调 `s2s_inbox` 读取 → B 生成回信,调 `s2s_send {to:A, kind:"reply", replyTo:msgId}`。
4. 插件把回信 splice 回 A 的 Inbox;若 A 的 `s2s_send` 设了 `wait:true`,插件把回信内容同时作为该工具调用的最终工具结果送达 A 的当前 turn(免轮询)。

---

## 4. 详细设计

### 4.1 注册表(① s2s-registry)
- **live 真相**:枚举 `ctx.agents` → {sessionId, cwd, title, phase(idle/turn 中), lastActivity}。【待验证 OQ-1】
- **静止列表**:扫 `~/.dsh/sessions/<cwd-编码>/session-*` 的日志 mtime + 标题事件(插件在宿主侧,不受 workspace-write 限制)。
- **跨进程预留**:每宿主写 `~/.dsh/s2s/hosts/<bootId>.json` 心跳(端口+会话清单)。v1 假设单进程;接口留位;hybrid 下由 @dpskh/a2a 兜底多进程。

### 4.2 消息封装(envelope)
```json
{
  "v": 1, "msgId": "s2s-01J...", "from": "<sessionA-id>", "to": "<sessionB-id>",
  "topic": "wellpay-重构", "kind": "request | reply | notify | abort",
  "hop": 0, "budget": { "maxHops": 6, "expiresAt": "<iso>" },
  "replyTo": null, "urgent": false,
  "body": "人类可读正文;可含工作区相对路径引用"
}
```
落盘形态:`user/message`,content 为渲染后的正文 + 代码块包裹的 envelope;source = `{ kind:"plugin", plugin:"dsh-s2s", peer:"<from-id>", msgId, kind, topic }`——GUI 侧一望即知是 s2s 信件而非用户打字。

### 4.3 送达与唤醒(② s2s-transport)
- **live-idle**:`Inbox.append("nextTurn", msg)`。
- **live-busy**:默认同上排队;`urgent:true` 时走 `nextStep`(与人类 steering 同边界消费,风险见 OQ-3)。
- **dormant(静止/done)**:写 `~/.dsh/s2s/mailboxes/<sessionId>/<msgId>.json` 占位 → 插件调 `ctx.agents.resume(ownerCtx, { resumeSessionId })` **拉起**(日志重放→发布→loop 启动,GUI 中该 session 复活可见)→ 监听 `agent/created` drain mailbox → 信件 splice 进 nextTurn,loop 正常消费并回信。防双开:目标 id 已 live 时 resume 被拒,改走 live 路径。授权闸见 D6。【OQ-4:drain 恒排人类待发输入之后;OQ-5:dispose 语义】
- **回信路由**:A 发出 `expect:"reply"` 的信后,插件在 A 侧注册 pending-replies 表;回信到达即双向送达(Inbox splice + 若工具调用仍挂起则作为其工具结果)。`wait` 超时(默认 120s)返回 `timeout`,信不丢,后续可 `s2s_inbox` 收。

### 4.4 模型工具面(③ 仅 3 个)

| 工具 | 参数 | 返回 |
|---|---|---|
| `s2s_list` | `query?`(cwd/title 子串) | [{sessionId, title, cwd, state: live-idle/live-busy/dormant, lastActivity}] |
| `s2s_send` | `to`, `body`, `topic?`, `kind?`(默认 request), `expect?`("none"|"reply"), `wait?`, `urgent?`, `budget?` | {msgId, delivered: "inboxed"|"queued-dormant", reply?} |
| `s2s_inbox` | `take?`(默认 true:取走即清队) | [{envelope, fromState}] |

(hybrid 分支下,live 半环复用 @dpskh 的 `a2a_peers/a2a_message/a2a_history`;本表 3 工具仅在自研全栈分支启用,另补 `s2s_resume`。)

### 4.5 防回环与预算
- 每信 `hop`,插件拒绝 `hop > maxHops`(默认 6)的信;`expiresAt` 过期即丢弃并回 `abort`。
- 每 (from,to) 对滑动窗口限速(默认 10 封/分钟)。
- **D5**:默认仅 `request→reply` 一来一回;B 若要开启多轮,须其 config 允许 `autonomous:true`。

### 4.6 权限与人类可见性
- 默认同宿主互发允许;跨 workspace(cwd 不同)时按 `dsh-jobs` 围栏精神,**首封信前需该 session 的人类批准一次**(config 可关)。
- 全部信件走 surface 事件,GUI 天然可见;信件正文带固定前缀水印(如 `[s2s·topic]`)。

### 4.7 配置与挂载
Config(schemastery)字段:`enabled`, `maxHops`, `ratePerMinute`, `waitTimeoutMs`, `crossWorkspace`("ask"|"allow"|"deny"), `autoResume`("ask"|"allow"|"deny",默认同 workspace allow), `autonomous`, `mailboxDir`。
挂载:`~/.dsh/profiles/web/cordis.patch.yml` 追加 `{ id:"dsh-s2s", name:"<本地路径>", config:{...} }`(照 `dsh-extra-writable-roots` 模式);wrap 式、失败不拖垮宿主。

---

## 5. 提议的文件结构(评审后才开始写)

```
plugins/dsh-s2s/
├── SOLUTION.md          # 本文档
├── package.json         # type:module, private
├── index.js             # cordis apply:inject ["agents","tools"],注册三层
├── registry.js          # ① live/dormant 枚举
├── transport.js         # ② envelope、splice 送达、pending-replies、resume 拉起
├── mailbox.js           # 静止信箱 + agent/created drain
└── tools.js             # ③ 工具定义(defineTool,照 tool-todo 模式)
```

## 6. 里程碑(hybrid 口径)

- **M1 发现 / M2 live 环**:~~自研~~ → **superseded by 采用 @dpskh/a2a**(§0.5;若其 6 项检查不过,回退自研分支:骨架+registry+`s2s_list` 先行验证 OQ-1)。
- **M3 拉起静止 session(D4/D6)**:**主线**——mailbox + `AgentRegistry.resume` 接线 + 防双开 + 授权闸。
- **M4 加固与礼仪**:hop/限速/授权闸 + 本文档终稿 + skill `s2s-etiquette`(纯提示侧:何时找谁、topic 规范、budget 礼仪、向人类汇报格式;hybrid 下兼管 a2a_* 的使用礼仪)。

## 7. 风险与开放问题

| # | 问题 | 影响 | 拟答 |
|---|------|------|------|
| OQ-1 | 从 `ctx.agents` 句柄拿到目标 agent Inbox 实例的公开路径(`Inbox` 构造需 session+notifications,或 agent 上有现成暴露) | M2/自研分支前提;hybrid 的 resume-drain 也需要 | M1 期间读 dsh-agent-loop 源确认;备选:自建 Inbox 投影复刻 claim 语义 |
| OQ-2 | 本部署是否严格单宿主进程 | 跨项目可达性 | v1 单进程假设+心跳预留;hybrid 下由 @dpskh/a2a 兜底 |
| OQ-3 | `urgent` 走 nextStep 时,消息被当轮消费的语义边界 | 体验 | 默认不用;开启前实测 |
| OQ-4 | drain 与人类待发输入的竞态顺序 | 正确性 | drain 恒排人类之后 |
| OQ-5 | `AgentHandle.dispose()` 文档言 "removes its session from the store"——需确认仅指内存 live store、不动 zstd 持久日志 | 拉起善后 | 默认**不自动归眠**(留在 live-idle,人类手动关);auto-dispose 仅作 config 实验项 |
| R-1 | 回环/token 失血 | 成本 | §4.5 三重闸 + D5 默认关 |
| R-2 | 插件崩溃 | 宿主稳定 | wrap 式挂载、加载失败不提供同名服务(v2 事故教训) |
| R-3 | 沙箱写权限 | mailbox 位置 | 插件在宿主侧,不受 workspace-write 限制;session 工具层不直写 ~/.dsh |
| R-4 | 供应链信任(采用 @dpskh/a2a 时) | 宿主安全 | §0.5 六项检查,源码审查前置 |

## 8. 已否决的替代方案

1. **纯 skill**(最初假设):session 之间"没有耳朵"——本部署未挂 `tool-cordis`/`schedule`,无法自唤醒、无法自装插件;skill 只能覆盖发现与礼仪(≈四成价值)。
2. **headless 信使**(`dsh --profile headless`):新建的是一次性第三方 agent,不是对方那个带上下文的活 session。
3. **直写对方 session 日志**:与活写方竞态、事件校验拒收、损坏风险。
4. **逆向 typert HTTP**:握手+鉴权,脆,不可维护。

## 9. 评审请求

已定:D1(更名 dsh-s2s)、D2(s2s_* 工具)。**请重点拍板**:§0.5 的 hybrid 分工(是否采用 @dpskh/a2a 作 live 层)与其 6 项前置检查的执行顺序、D3–D6,以及 §4.4 工具形态;确认后进入 M3(拉起静止 session)或先跑 @dpskh/a2a 检查清单。

---

## 10. 设计修订 R5(已定稿方向):同宿主改走进程内 broker,零端口

> 来源:试运行后评审提出「为什么开这么多 TCP 端口?更优雅的内建消息队列?」——同宿主单进程用上游 hub+WS(跨主机层)属过度设计。

### 10.1 结论

- **上游 @dpskh/a2a 的 hub server + WebSocket 是为跨进程/跨机 DSH mesh 设计**;同宿主两个 session 住在同一进程、共享同一 cordis Context,却绕 hub 监听端口转发,是「用跨主机工具干同进程的活」。
- **同宿主应该走进程内直投**:
  - 新增 `S2sBroker`(cordis 服务,注入 [agents]):`send({target: sessionId, ...})` → `ctx.agents.get(SessionId(sessionId))` → `agent.followup/inject`(与 mesh 现有投递同构,但要给 broker 一个「按 sessionId 寻址」的通道)。
  - 信箱(mailbox)+ `AgentRegistry.resume` 保持不变(静止/离线唯一需要落盘的部分)。
  - **零 TCP 端口、零 WS、零序列化、零重连/claim**;配现有的防回环预算与授权闸。
- **生成性影响**:把同宿主路径的「投递」从 `工具→mesh.message→hub client→WS→hub server→WS→deliver→inject` 压成 `工具→broker.send→(agent followup/inject)`。hub 的 registry/history/presence 身份仍以**进程内服务**保留(无监听);仅当将来真要多机互通才开 `hub.server`。

### 10.2 与既有决策的关系

- **D1/D2 不变**;工具面 `s2s_* 5 项` 不变(broker 是 delivery 层替换,不是工具形态变更)。
- **D3/D5/D6 不变**(队列决策、默认多轮关、授权闸)——broker 只换投递介质。
- **上游协议 v3 / hub 层保留为可选跨机扩展**;本 fork 默认以进程内投递为主。

### 10.3 验证锚点

- 全链路在**隔离 profile/test**(新端口+全新 storages)先行;凭证同 L3/L4。
- broker 单测:直投(空闲/忙碌)、dormant→信箱、allow→resume+投递、防双开。

### 10.4 现状

- 当前已上线的**默认配置已实现 0 端口**(`hub: {}`);broker 作为下一阶段把同宿主路径彻底去 WS 的重构,先写设计、后实现,再走隔离测试再上 web。

