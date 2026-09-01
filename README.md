# dsh-s2s — DeepSeek Harness 的 Session-to-Session 同宿主会话互联

> 一个 cordis 插件,让**同一台宿主上的多个 DSH session 互相对话**——按**会话名(标题)**点名即可,并支持**拉起已结束(静止)的 session**。

**实现思路受 a2a 启发,但并非其 fork**:a2a 是跨主机 mesh(hub + WebSocket + presence);而 s2s 是**同宿主单进程**路径,因此**不继承其 hub/网络层**,只借鉴了它的**注入习语**(空闲→`followup`、忙碌→`inject`)。s2s 用一个**进程内 broker** 直接投递,**零 TCP 端口、零 WS、零重连**。原 a2a 版实现归档在本仓库历史与 `legacy-a2a` 分支,作参照。

> 使用手册见 [docs/USAGE.md](docs/USAGE.md);踩坑记录在本机 `plugins/LESSONS.md`(不进仓库);设计证据稿见 [docs/SOLUTION.md](docs/SOLUTION.md)(v0.2 历史基线)。

---

## 它是什么 / 不是什么

| | s2s(本项目) | a2a |
|---|---|---|
| 拓扑 | **同宿主/单进程** | 跨进程/跨机(可信局域网) |
| 传输 | **进程内 broker 直投,零端口** | hub server + WebSocket |
| 寻址 | **name(标题)主寻址,现读不缓存** | roster / presence |
| 静止会话 | ✅ 按名**拉起**(`AgentRegistry.resume`)(a2a 没有) | ❌ 仅在线接收方 |
| 防回环 | ✅ 发送侧 hop/限速 | ❌ |
| 浏览器 UI / 命令面 | ❌ 无(精简) | ✅ |

## 功能一览

- **进程内投递**:`S2sBroker.deliver(sessionId, {from,text})` → `ctx.agents.get(...)` → `agent.followup`(空闲)/`inject`(忙碌)。零网络、零序列化。
- **name 主寻址**:`s2s_resume(name: "开发", ...)` / `s2s_message(name: "产品", ...)`;每次解析**现读会话最新标题**(日志 `session/title` 事件),改名即刻生效;同名→`ambiguous`(用 `session_id` 消歧),查无→`not-found`+候选。
- **拉起静止会话**:入信箱 → `autoResume=allow` 时 `AgentRegistry.resume` 拉起 → 投递;拉起的会话保留 live-idle(不自动归眠)。
- **5 个模型工具**:`s2s_peers`(live)/ `s2s_sessions`(全部+标题+三态)/ `s2s_message`(发/唤醒)/ `s2s_resume`(显式唤醒)/ `s2s_history`(进程作用域历史)。
- **持久信箱**:`~/.dsh/s2s/mailboxes/<sessionId>/*.json`,原子写、时序命名、损坏自愈。
- **按需加载**:`lifecycle`/`budget` 配置块缺席即不挂载;broker/discovery/tools 恒挂(核心)。

> 详细用法见 [docs/USAGE.md](docs/USAGE.md)。

## 挂载

装**新**插件必须用 **`- insert:`** 形式,且 `name` 指向可解析的 ESM 入口(不能是目录):

```yaml
- insert:
    - id: dsh-s2s
      name: ./dsh-s2s/lib/index.js
      config:
        lifecycle:
          autoResume: allow       # s2s_resume 用 name 点名即拉起投递
        budget:
          maxHops: 6
          ratePerMinute: 10
```

零端口:无需配 hub/server(那已是跨机 a2a 的事)。

## 与 a2a 的关系

- **非 fork**:同宿主场景独立实现(进程内 broker),不继承 a2a 的 hub/WS 层;仅借鉴其**注入习语**与错误编码风格。
- 若需要**跨进程/跨机** DSH mesh,请直接用 a2a——那是它的主场。
- 非 DSH 的标准 A2A agent(AgentCard/JSON-RPC)需网关类插件,本包不提供。

## 路线图

- ✅ **进程内重构**:去 hub/WS,broker 直投;name 寻址 + 静态会话拉起 + 信箱 + 预算。
- **待做**:`s2s-etiquette` skill;邮箱/历史持久化强度调优。

## 开发

```sh
pnpm install
pnpm run typecheck     # 0 错
pnpm run test          # 24/24
pnpm run build         # 产出 lib/index.js (~28kB)
```

## License

MIT。注入习语受 a2a(MIT)启发;本实现独立成文。

