# dsh-s2s 定时注入方案(修正版,方案先行)

> **功能 = 单会话内「定时拉起 + 注入 prompt」**。跨会话(按名唤醒/注入其他 session)是 **s2s 的本职**(s2s_sessions/s2s_resume/s2s_message + broker/lifecycle),**不在本功能范围**。

## 0. 结论(一句话)

**依赖官方 `@deepseek-ai/dsh-schedule` 作为 cron 引擎(durable、D5 安全、session-local 全内建),我们只加一层「执行 framing」薄封装;不重造调度器。**

## 1. 为什么引擎用官方(已验证)

- **cron 引擎内建**:`schedule_create/list/delete` 建记录(创建是按需,像工具),写进**会话日志**由 `ScheduleRuntime` **自我驱动、按周期自动触发**并注入——不是「调一次才动一次」的 skill。
- **durable**:`schedule/change` 事件重放即恢复,重启/自愈。
- **D5 安全**:idle 才投(不打断在跑的 turn)、`resolveEveryOccurrence` 只取最新一次到期(静止会话唤醒**只触发一次**,不补 backlog)。
- **session-local**:工具作用于「当前会话」——**正是「自己给自己定时」的语义**。

## 2. 我们唯一要加的:执行 framing(薄封装)

官方到点注入是 **展示提醒给用户、且注明不可当新指令**——即**展示提醒**。我们要的是**让会话拿 prompt 去执行**。

- 所以在官方触发点之上,**加一层薄库**:把注入改写为 **`source: { kind: 's2s-schedule' }` + framing「这是调度的任务指令,请执行,而非仅展示;来源 = 任务创建者」**。
- **只改注入语义,不重建调度器**;官方仍是持久化/触发/D5 的承担者。
- 挂载方式:`schedule?: { enabled?: boolean; framing?: string }` 或一个独立小 plugin(待定,见 §5 开放问题)。

## 3. 触发后语义

1. 到点(官方 runtime 判定 due + idle)→ 我方薄层注入执行 framing 的 prompt。
2. 目标会话**收到后该做什么**,仍取决于**该会话自己的模型/自主性**(D5):我们保证「到点注入一条要执行的 prompt」,不保证它自动跑完整串活——**诚实边界**。
3. 会话若已 **dormant**:官方 `isLive()` 门控**不主动唤醒**;如需「定时唤醒静止会话」,这是 **s2s resume 的本职**,本功能不重复——跨会话行为由 s2s 兜底。

## 4. 范围边界(明确不做)

- ❌ 不做跨会话定时注入(归 s2s)。
- ❌ 不自建调度器/持久化(官方已给)。
- ✅ 只做:引擎复用官方 + 一层执行 framing。

## 5. 开放问题(实现时要定)

- **挂载点**:官方 runtime 在 `agent.followup(message)` 时注入;我们的执行 framing 是**替换官方注入**还是**在其后追加**?需读官方 `lib/index.js` 的 `injectMessage`/`requestDrive` 细节确认最薄 hook 点。
- **间隔下限**:官方 `MIN_EVERY_INTERVAL_SECONDS = 300`(every ≥5min);若需更短的可配下限,测试走 `after`/`at` 或调低(官方仅对 every 设下限)。
- **依赖/版本**:官方 peers `^0.1.1-rc.2` vs dsh-s2s `^0.1.0-rc.6`——官方独立挂载(不进 s2s peers),运行时版本线需与宿主一致。

## 6. 测试锚点(实现后)

- 本体:官方 schedule 工具的 create/list/delete;到点注入(含 idle 才投、latest-only 单触发)。
- 薄封装:执行 framing 是否生效(注入 msg source kind = s2s-schedule、内容含执行语义);与官方默认「present」framing 的差异。

## 7. 工作量

- **引擎**:0(官方)。
- **执行 framing 薄层**:1 个文件 + 少量配置 + 1-2 个测试;不重造调度器。
- **部署**:web profile 安装 + `- insert:` 挂载官方 dsh-schedule(部署动作)。

