## 智能预算 + 会话内定时唤醒

本轮将前两轮功能一并交付。

### 会话内定时唤醒(s2s_schedule)

- 新增 `s2s_schedule` 工具:list / create(every_seconds 周期 或 at_iso 单次) / cancel,给目标会话周期或定点注入提示;busy 不丢、dormant 交生命周期队列。
- 通过会话投影 `s2s-schedule` + `s2s/schedule-change` 事件,把任务目录暴露给浏览器「计划 / Scheduled」tab(由独立 UI 插件消费该投影)。

### 智能预算(反无意义循环)

- `budget.semantic`:默认 ≤6 次宽限完全不干预;超过后由模型判官读最近 6 次交互判定是否有意义;`hard` 显式 break / `soft` 建议停止;判官失败降级到计数门(绝不误断)。
- 判官用发送方会话当前模型;verdict 缓存复用 + 短 prompt,抑制成本。

### 项目作用域

- `s2s_peers` / `s2s_sessions` 默认只列**当前项目**会话;`all=true` 列所有项目。`s2s_message` / `s2s_resume` 仍可按 name / session_id 跨项目点名。

### 文档

- 使用说明移入仓库根 `USAGE.md`;docs/ 只留设计稿。
