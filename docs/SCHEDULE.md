# dsh-s2s 定时注入 — 薄 framing 实现稿(方案先行)

> 功能 = **单会话内「定时拉起 + 注入 prompt(执行语义)」**。引擎**复用官方 `@deepseek-ai/dsh-schedule`**,我们只加一层**薄执行 framing**。跨会话唤醒/注入归 s2s 本职(不在本功能)。

## 0. 一句话

**官方 `dsh-schedule` 当 cron 引擎;我们加 1 层薄库把它的「present reminder」注入改为「scheduled task, execute」注入。**

## 1. 薄 framing 层(实现内容)

### 1.1 做什么
- 拦截官方到点注入,把注入的 prompt 语义从 **「展示提醒给用户」** 改为 **「这是调度的任务指令,请执行」**。
- 注入消息:**`source: { kind: 's2s-schedule' }`** + framing 头(防注入 + 明确执行语义)。

### 1.2 设计(两种薄实现,选一)
- **A. 替换注入**:在官方 runtime 的注入点之前接管,我方注入执行 framing(需 hook 官方 inject 点,见 §5)。
- **B. 追加注入**:官方仍注入「展示提醒」;**我方再注入一条**「执行 framing」的调度任务 prompt(与 s2s 现有 `s2s-lifecycle` 投递同构)。**更薄、无侵入**,推荐先做 B。

### 1.3 配置
`schedule?: { enabled?: boolean; framing?: string }`(absent 不挂载 / 自定义 framing 文本)。

## 2. UI / 交互设计(重要)

**结论:不需要自制 GUI 面板。** 这是 DSH 插件,交互走**原生 GUI + 模型工具 + 消息**,不是定制 UI。

### 2.1 交互面(用户能看到/做的)
- **配置定时**:会话里说一句「每小时提醒我检查待办」→ 会话调官方 `schedule_create`(或薄层 s2s 工具)。**工具调用在 GUI 里原生可见。**
- **管理定时**:说「列出我的定时任务」→ 会话调 `schedule_list`;「取消 X」→ `schedule_delete`。**全是对话式,无需面板。**
- **到点注入**:注入的 prompt 作为一条消息出现在该会话里(带 `s2s-schedule` 来源标记)。**GUI 已有消息渲染,无需新组件。**

### 2.2 为什么不加面板
- DSH 插件惯例是**扩展工具/消息**而非做独立 UI 面板;会话本身可做任何管理(对话式)。
- 加面板 = 非标准 + 维护负担,且与模型工具重复(模型已能 list/cancel)。
- **除非**你明确要一个「可视化定时列表/开关」的独立面板 —— 那是另一规格,另议。

## 3. 边界(诚实)
- 到点 = 注入执行 prompt;**跑多深取决于目标会话自主性(D5)**。
- 会话 dormant:官方 `isLive()` 不唤醒;唤醒静止会话是 s2s 的事,本功能不重复。

## 4. 不做(明确)
- ❌ 跨会话定时注入(归 s2s)。
- ❌ 自建调度器/持久化(官方已给)。
- ❌ 独立 GUI 面板(对话式已够)。

## 5. 开放问题(实现时定)
1. **hook 点**:替换(方案 A)还是追加(方案 B)?推荐 B(更薄、无侵入)。
2. **间隔下限**:官方 `every ≥300s`;更短需可配(仅对 every 设下限;测试走 `after`/`at`)。
3. **版本**:官方 peers `^0.1.1-rc.2`,独立挂载,运行时版本线与宿主一致。

## 6. 测试锚点
- 薄层:B 方案下,注入 msg source kind = `s2s-schedule`、内容含执行 framing;与官方「present」framing 的可区分。
- 官方本体:schedule_create/list/delete;到点 idle 才投、latest-only 单触发。

## 7. 工作量
- 引擎:0(官方)。
- 薄 framing:1 文件(B 方案监听 schedule 到期 → 追加注入)+ 配置 + 1-2 测试。
- 部署:官方 schedule 已使能(web profile)。

