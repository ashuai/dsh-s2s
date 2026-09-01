# dsh-s2s 定时注入 — 实现稿(creator 路由,方案先行)

> 功能 = **单会话内「定时 + 注入 prompt」**,按**创建方路由**:**我们的 `s2s_schedule` 工具 → 执行语义(我们注入);官方 `schedule_*` 工具 → 提醒语义(官方注入)。** 跨会话唤醒/注入归 s2s 本职。

## 0. 一句话

**两条调度面并存、按创建方路由:我们的面 = `S2sScheduleService`(轻量自研,执行语义);官方面 = `@deepseek-ai/dsh-schedule`(官方引擎,提醒语义)。不用 hook/替换官方。**

## 1. 双面架构(creator 路由)

| | 我们的 `s2s_schedule` | 官方 `schedule_*` |
|---|---|---|
| 引擎 | **S2sScheduleService**(自研轻量) | 官方 dsh-schedule |
| job 存储 | 我们的 durable(会话日志事件或 job 文件) | 官方 session log fold |
| 注入语义 | 「调度任务,执行」(source kind `s2s-schedule`) | 「展示提醒」 |
| 触发 | 我们的定时器 | 官方 runtime(durable、D5) |
| 创建方 | 会话/agent 调 `s2s_schedule` | 会话/agent 调 `schedule_*` |

**互不干扰**:我们创建的不走官方注入,官方创建的不走我们注入 → **不会出现两条消息**。

## 2. 我们的 `S2sScheduleService`(最小实现)

- **job 模型**:`{ id, target(本会话), everySeconds?/atIso?, text, nextAt, enabled, createdAt }`。
- **持久化**:会话日志事件(如 `s2s/schedule-change`)或 job 文件;重放恢复 `nextAt`。
- **触发**:进程内 timer;到点 idle 才注入(不打断)/ busy 跳过并推后 / dormant 由 s2s 拉活。
- **注入**:`source: { kind: 's2s-schedule' }` + framing「这是调度的任务指令,请执行;来源 = 任务创建者」——防注入 + 保执行语义。
- **工具**:`s2s_schedule action=list / create / cancel`。

## 3. 间隔(我们的面)

- **≥5min 走周期,<5min 由代码自动切一次性 `at`(或自节拍)**;默认常量,无配置页。
- 官方面:官方 `MIN_EVERY_INTERVAL_SECONDS=300` 只约束用官方工具时。

## 4. UI / 交互(计划 tab,独立阶段)

- 计划 tab 走 DSH 插件化客户端:`dsh-client-ui-cordis`/`layout` 在**会话窗口容器**里 append 一个 surface(照 `dsh-client-ui-trajectory` 的挂法);暂定包名 **`dsh-session-plan`**。
- 宿主侧:一个 Remote 暴露调度数据(我们 fold + 官方 fold)与 list/cancel。
- 注:tab 是**独立阶段**,先把双面调度做出来、你看过官方再动 UI。

## 5. 边界(诚实)
- 到点注入执行 prompt;**执行多深取决于会话自主性(D5)**。
- dormant 唤醒归 s2s(不在本功能)。

## 6. 不做(明确)
- ❌ 跨会话定时注入(归 s2s)。
- ❌ hook/替换官方注入。
- ❌ 配置页(间隔是常量)。
- ❌ 独立 GUI 面板在 UI 阶段前(对话式先够)。

## 7. 测试锚点
- `S2sScheduleService`:create/list/cancel;到点 idle 才投/忙推后/间隔 <5min 切 at;重放恢复。
- creator 路由:我们创建的任务只走我们注入(source `s2s-schedule`),官方创建只走官方提醒。

## 8. 工作量
- 我们的面:`S2sScheduleService` 1 文件 + 工具 + 测试(复用 s2s 投递/生命周期)。
- 官方面:0(已使能)。
- 计划 tab:独立阶段(客户端包 + Remote),另估。

