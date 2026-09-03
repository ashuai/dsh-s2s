## 首个发布 / 基线

dsh-s2s 的首个可发布基线:同宿主会话间(session-to-session)互连,无 hub / 网络 mesh。

### 核心能力

- **s2s_message**:向同宿主另一会话投递消息;live 会话用 idle-aware 注入(busy 走上下文注入),dormant 会话入邮箱。
- **s2s_resume / lifecycle**:唤醒休眠会话(AgentRegistry.resume)并投递,留在 live-idle(不自动回收);autoResume 可配 allow/deny;持久化邮箱(每条一 JSON、原子写、重启不丢)。
- **s2s_sessions / s2s_peers**:按名称(title)/ session_id 解析会话(discovery)。
- **s2s_history**:进程内最近消息记录。
- **反循环预算**:maxHops(默认 6)+ ratePerMinute(默认 10/min),opt-in,失败即响。
- **s2s_schedule**:会话级定时注入(list/create/cancel;every_seconds 周期或 at_iso 单次;busy 不丢),并通过 session 投影 `s2s-schedule` 驱动浏览器「计划 / Scheduled」目录(独立 UI 插件消费该投影)。

### 结构

- host-only 插件,`main: lib/index.js`;broker + discovery 常开,lifecycle/budget/schedule 按 config 可选。
- `lib/` 由 `pnpm build`(tsc + tsdown)生成,仓库忽略(发布时经 prepare 或自带 lib/ 分发)。

### 本次一并入库

- `.github/workflows/release.yml`:变更片段(changes/)触发 GitHub Release 的流程。
- `changes/` 目录 + 约定 README。
- `docs/BUDGET.md`:`智能预算`(反无意义循环)设计稿,待下一轮迭代实现。
