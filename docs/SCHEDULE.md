# dsh-s2s 定时唤醒解决方案(设计稿)

> 目标:让一个会话能「上定时器」——每隔 N 或定点**拉起它干活**。这是**会话内的功能**,需要**该会话的上下文**(任务内容、它的设定),因此 job 归属会话、携带该会话要执行的指令。

## 0. 背景与结论

- DSH 上游有 `@deepseek-ai/dsh-schedule`(`createEveryScheduleRecord`/`createAtScheduleRecord`/`MIN_EVERY_INTERVAL_SECONDS`),是原生定时提醒;**但当前 web profile 未挂载它**(组合树只有 `timer`,node_modules 也未链 schedule)。
- 本方案**不依赖上游 schedule 包的挂载状态**,在 s2s 内做最小的、会话内的定时唤醒,复用已有的按名寻址(discovery)与拉起(lifecycle)/投递(broker)。
- **核心判断**:定时唤醒 = **到点把一条携带会话上下文的指令喂给目标会话**;不应造一个独立的全局调度器,而应让 **job 挂在会话下**——因为「做什么」依赖那个会话的上下文,且天然与其生命周期(静止/忙碌)对齐。

## 1. 为什么是会话内(且要会话上下文)

- 用户语义是「给产品会话上定时器,每小时拉起它干活」——job 是产品的,任务内容是产品要执行的。
- 若做成全局 cron,需额外把任务/上下文塞给目标会话,违背「会话自持任务」的直觉,也难处理该会话独有的设定/待办。
- 把 job 存在**会话名下**(如 `~/.dsh/s2s/jobs/<target>/*.json`),触发时读该会话上下文做投递,语义闭合、可持久、可迁移。

## 2. Job 模型(最小)

```ts
interface S2sScheduleJob {
  id: string              // 稳定 id
  target: string          // 目标会话标题/name(按名解析),或 sessionId
  everySeconds?: number    // 周期触发(如 3600)
  atIso?: string           // 定点一次触发(与 every 二选一)
  text: string             // 触发时投递的指令(可引用目标会话上下文)
  from?: string            // 发送者标签,默认 scheduler
  enabled: boolean,
  nextAt: number           // 下次触发 epoch ms
  createdAt: number
}
```

- `every` 用秒(建议 ≥10s 避免测试抖动);`at` 一次,触发后删除;`every` 持续,触发后 `nextAt += every`。

## 3. 服务与流程

- **`src/schedule.ts` → `S2sScheduleService`**,`inject ['agents']`;配置 `schedule?: { enabled?: boolean; dir?: string }`(absent 不挂载)。
- **持久化**:`~/.dsh/s2s/jobs/<id>.json`,原子写;mount 时加载并恢复 `nextAt`(重启后到点继续)。
- **触发**:进程内 timer(`setInterval`,如 30s)扫描;`now >= nextAt` 时:
  1. `discovery.resolve(target)` 按名解析(现读标题)。
  2. 目标 **live-idle** → `broker.deliver(text)`(followup,立即一轮)。
  3. 目标 **live-busy** → **跳过本轮**并推后 `nextAt`(防叠加/防打断正在跑的任务)。
  4. 目标 **dormant** → `lifecycle.queueForDormant`(`autoResume=allow` 则 resume 拉起 + 投递;否则入信箱等重开)。
  5. 推进 `nextAt`,写回并持久化。
- **防重入**:`nextAt` 推进 + busy 跳过;同一 job 不并发触发。

## 4. 工具形态

`s2s_schedule`(与 `s2s_sessions`/`s2s_resume` 同族):

```text
s2s_schedule action=list
s2s_schedule action=create target=产品 every=3600 text=每小时检查待办 from=scheduler
s2s_schedule action=cancel id=<jobId>
```

- 用**标题(name)**定位目标(与 s2s_sessions 一致);`session_id` 兜底消歧;1 工具 3 action,最小界面。

## 5. 与 DSH 原生 dsh-schedule 的关系

- 可**对齐其领域模型**(every/at、reminder framing、最小间隔)以保持一致性;但**独立实现**轻量、会话内、按标题寻址的版本,不依赖其挂载。
- 若以后 web profile 挂上 `dsh-schedule`,可把 job 投递改为走它的 remind 机制,本服务退化为 job 存储层。

## 6. 边界与诚实声明

- **D5**:多轮自主默认关。触发 = 叫醒目标会话 + 喂一条指令;**执行多深取决于目标会话的自主性配置**——我们保证按时叫醒并给任务,不保证它自动跑完整串活。
- **进程内 timer**:跨重启靠持久化恢复 `nextAt`(小时级足够)。
- busy 跳过:宁可少触发一次,不打断正在进行的任务。

## 7. 测试锚点

- `tests/schedule.spec.ts`:创建/列出/取消;到点触发(live-idle→followup、live-busy→跳过并推后、dormant→resume+投递);`every` 推进;`at` 一次删除;重启恢复 `nextAt`。

## 8. 工作量(估算)

1 个新文件(`src/schedule.ts`)+ 工具接入(`tools.ts` 加 1 工具)+ 配置块 + `schedule.spec`(5-6 例)。复用 discovery/lifecycle/broker,最小增量。

