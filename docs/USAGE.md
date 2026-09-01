# dsh-s2s 使用手册

> 同宿主 session 互联 + 静止会话唤醒。裁剪 fork 自 @dpskh/a2a(见 README 鸣谢)。

## 1. 挂载(profile patch)

装**新**插件必须用 **`- insert:`** 形式,且 `name` 指向**可解析的 ESM 入口文件**(不能是目录):

```yaml
- insert:
    - id: dsh-s2s
      name: ./dsh-s2s/lib/index.js
      config:
        hub: {}                    # 纯 in-process hub,不开监听(默认 0 端口)
        mesh:
          project: main
          persistConnections: true
          autoConnect: false       # 不自动入网;工具仍会注册
        lifecycle:
          autoResume: allow         # s2s_resume 用 name(标题)点名即拉起投递
        budget:
          maxHops: 6                # 发送侧防回环
          ratePerMinute: 10
```

- `name` 相对 profile 目录解析:把插件 symlink 到 `<profile>/dsh-s2s`,或用 `.dsh/profiles/<profile>/dsh-s2s/lib/index.js`。
- 改配置后**由用户在终端重启对应 profile**(agent 不得代杀前台进程)。

## 2. 配置字段

| 块 | 字段 | 默认 | 说明 |
|---|---|---|---|
| `hub` | `server` | 无 | 不填=`{}` 纯 in-process hub(registry+history,不开监听);填 `server:{host,port}` 才监听(mesh hub) |
| `mesh` | `project` | `main` | 项目名 |
| | `persistConnections` | `true` | 每会话连接记忆(settings 域 `s2s-connections`) |
| | `autoConnect` | `false` | 不自动 join presence;join 由后续/命令面(已裁)承担,单会话直连走工具 |
| `lifecycle` | `autoResume` | `allow` | 对静止会话:`deny` 仅入信箱;`allow` 拉起+投递 |
| | `mailboxDir` | `~/.dsh/s2s/mailboxes` | 信箱根 |
| `budget` | `maxHops` | 6 | hop 上限,超过拒绝 |
| | `ratePerMinute` | 10 | 每 (from,to) 对每分钟上限 |

缺席的块不挂载(按需加载);`lifecycle`/`budget` 未配置时对应功能关闭。

## 3. 模型工具(5 个)

| 工具 | 作用 |
|---|---|
| `s2s_peers` | 列当前 roster(在线的对端) |
| `s2s_message` | 发给某对端或广播 project(带预算检查) |
| `s2s_history` | 按 ref/before/after/limit/from 查历史 |
| `s2s_sessions` | 列会话含 **标题(用户改名)** + 短 id + `live-idle`/`live-busy`/`dormant` 三态 |
| `s2s_resume` | 用 **name(标题)** 点名(主寻址)或 `session_id`;唤醒 dormant:入信箱;`autoResume=allow` 则 `AgentRegistry.resume` 拉起并立即投递 |

## 4. 唤醒静止会话流程(name 为主寻址)

1. `s2s_sessions` 看每个会话的**标题**(即你改的名,如「开发」),不用记 id。
2. `s2s_resume` `{ name: "开发", text, from? }`:
   - **标题是用户可随时改的**——每次解析都**现读最新标题**,改名即刻生效,绝不缓存;旧名下一条就是 not-found。
   - `autoResume=allow`:拉起会话 → `agent.followup`(空闲)/`inject`(忙碌)投递 → 清空信箱。
   - `autoResume=deny`:仅入信箱 `~/.dsh/s2s/mailboxes/<sessionId>/*.json`,会话重开时自动 drain。
   - **同名冲突**:返回 ambiguous + 候选列表,用 `session_id` 精确点名;无匹配:返回 not-found + 所有带标题会话供选。
3. 拉起的会话**保留在 live-idle**(不自动归眠;OQ-5 语义未尽)。

## 5. 验证

- 单元/集成:插件内 `pnpm run typecheck`(0 错)+ `pnpm run test`(70/70)。
- profile 载入:\`dump-config \` 应见 `dsh-s2s` 行且**无** `entry "dsh-s2s" not found`;若开 `hub.server` 可用 `curl <port>/` 看是否监听(404=在监听)。
- 全链路:重启 profile 后,在任一会话的工具列表应出现 `s2s_*` 5 项。

## 6. 限制

- **同宿主/单进程**拓扑;跨进程/跨机 DSH 请用上游 @dpskh/a2a;非 DSH 标准 A2A agent 需网关类插件。
- 与非 s2s 的 mesh(`a2a_*`)勿同挂:双 hub/双工具族/重复 presence。
- 命令面 `/s2s` 已随裁剪移除;live 多会话 join 依赖工具直连与 future broker。
