# 智能预算(Intelligent Budget)——语义判定式的反无意义循环

## 0. 一句话

把现有的 S2sBudget(纯计数:maxHops / ratePerMinute)升级为一个**可选的分层智能预算**:廉价确定性门先挡住明显失控,并给每个 (from,to) 对一个**宽限期**(默认 6 次):6 次以内的往返**完全不干预**,超过后才让**一个可用模型**读最近 N(默认 6)次交互做语义判定;若判定为「无意义的烧 token 行为」,就给出一个**明确 break**(硬失败),让调用方停止。不启用该层则完全不干预,回落到现有计数预算。

## 1. 问题与目标

### 要解决什么

- 两个会话通过 s2s_message 反复往返,可能演变成**无进展的 ping-pong**(互相 'ok / lgtm / 还有吗?' 或重复同样的论据),持续烧 token 而不产生新信息、新决策或新产物。
- 现有预算只按**次数/跳数**打分:它拦得住「量」,拦不住「质」——两人哪怕来回 20 次只敷衍,只要没超 rate 就放行。
- 目标:在不牺牲「真正有意义的连续迭代」的前提下,把**低质量的往返**识别出来并显式打断。

### 用户的真实语义(不擅自改需求)

- 不是全局断环,而是在「判定无意义」时 break;有意义的协作迭代要**继续**。
- 判定的依据是**内容语义**(最近 6 次交互),不是单纯计数。
- break 是**显式**的(给调用方一个明确信号),不是静默丢弃。

## 2. 现状与本方案边界

### 现有 S2sBudget(src/budget.ts)

    - 纯同步、无状态、opt-in(配置了 budget 块才挂)。
    - check(from, to, hop) 在 s2s_message 的 execute 里同步调用,**投递前**触发。
    - 只有两个硬约束:maxHops(默认 6)抛 S2S_BUDGET_EXCEEDED;ratePerMinute(默认 10/min)抛 S2S_BUDGET_RATE。
    - 哲学:每次 check 都是 plain throw,失败即响(不静默 drop)。

### 本方案边界(诚实声明)

- 智能层**默认关闭**,只在你显式开启时生效;开启后仍保留廉价门作为**兜底硬上限**。
- 「有意义」是启发式判断,存在**误判可能**;方案用「高置信 + 可审计 reason」收敛,但无法做到 100% 正确。
- 智能层本身也要花模型 token——方案通过**分层、采样、缓存、廉价模型**把它压到远低于被它拦下的循环开销。
- 它是**发送方**的守卫(在 s2s_message 里),不主动去对方会话里删改任何东西。

## 3. 可行性论证(基于现有实现)

### 3.1 内容来源:最近 N 次交互已经有

S2sBroker 维护进程私有 message log(records: Map<sessionId, S2sBrokerRecord[]>),S2sBrokerRecord = { sessionId, from, text, msgId, replyTo?, createdAt },每投递一条记录一次,上限 200。

对 (from=A, to=B) 的一对,要把「A↔B 的线程」重建出来:合并 records[B](发给 B 的,from=A)与 records[A](发给 A 的,from=B),按 createdAt 排序,取最后 N 条。msgId 可容忍重复投递,replyTo 可辅助拼接上下文。

> 注意:judge 在 budget.check(投递**前**)执行,所以它读到的是**已发生**的历史——正好是「这次发出去之前的最近 6 次」,语义正确。

### 3.2 模型呼叫 seam:存在

- @deepseek-ai/dsh-llm 暴露 LlmRuntime(ctx.llm 服务):prepareCall() 得到 PreparedLlmCall,其 stream(options) 返回 chunk 流,可聚合为一次完成的文本。
- @deepseek-ai/dsh-agent 提供 installModelSelection(lifecycle.ts 已经用了),可把某个 ModelSelection 绑到一次呼叫。**判官模型 = 发送方会话当前模型**,从 session.requestHeader().config 读它最后一次用到的 provider/model——judge 任务短,用当前模型即可,代码最少、成本几分钱。
- 替代路径:createAgent / resume 派生一个一次性微型 subagent,让它跑单轮返回 JSON verdict(用 agent 循环,更重但语义更完整)。

### 3.3 需要新增的接线

- S2sBudget 目前是 ctx.provide('s2sBudget', new S2sBudget(...)) 的**普通值**,没有 cordis Service 的 inject 面;要 call 模型,需要(1) 把它变成能拿到 ctx(或注入 llm/agents)的 Service,或(2) 接收一个注入的「judge 回调」cheap,避免预算服务自身耦合 dsh-llm 细节。
- check 需要**异步**(模型调用);tools.ts 里现以同步方式调 budget.check(...) 的几处要改成 await。

可行性判定:**可行**,且能从现有 seam 直接接上;主要工作在**分层触发 / 缓存 / 降级**,而不是新造一个 LLM 调用框架。

## 4. 最小设计

### 4.1 配置(新开一个 budget.semantic 子块,opt-in)

    budget:
      maxHops: 6             # 保留
      ratePerMinute: 10      # 保留
      semantic:              # 新增,关闭则走纯计数
        enabled: true
        # judgeModel?: string  # 可选覆盖;默认用发送方会话当前模型
        window: 6            # 进入判定后,读最近多少条交互
        graceExchanges: 6    # 往返≤6 完全不干预;>6 才进入语义判定
        confidence: 0.75     # 判定为无意义所需的最低置信
        cacheMs: 120000      # (from,to) 对缓存,窗口内复用判定
        break: hard|soft     # hard:抛错;soft:返回建议停止文本

### 4.2 触发分层(关键:防止 judge 烧 token)

    [1] 廉价门(现有,必过):hop < maxHops 且 rate < ratePerMinute
    [2] 宽限门:该 (from,to) 对往返深度 ≤ graceExchanges(6) → 放行,不进入语义层
        ↑ 6 次以内完全不管,自由往复;超过才继续
    [3] 缓存查询:cacheMs 窗口内已有该对判定 → 复用,不重复 call
    [4] 模型 judge:重建最近 window 条线程 → 一次模型呼叫 → JSON verdict
    [5] 落缓存 + 按 verdict 决定放行 / break

### 4.3 judge prompt 与 verdict schema

给模型的两段式 prompt:(a) 一个明确的「什么是有意义」rubric;(b) 最近 N 条消息的坐标(时间+发送方+内容),要求只输出严格 JSON。

- **有意义判别(任一即是):** 产生新信息/新事实/新决策;产出了产物(计划/代码/文件/方案);拆解了分歧或推进了目标;包含显式问题、权衡或新的可行动项。
- **无意义判别(token-burn):** 重复同一论据、纯附和、纯确认、状态复读、无新信息且无行动项的寒暄套话。
- **输出 schema:**

        {
          meaningful: boolean,  // 值域 true/false
          confidence: number,   // 0..1
          reason: string        // 人可读,供审计
        }

### 4.4 break 语义(显式,失败即响)

- 当 confidence >= 阈值 且 meaningful=false:**抛 S2sError 'S2S_BUDGET_MEANINGLESS'**,消息带 reason。与现有 budget「check 即 throw、fail loud」哲学一致。
- 这样发送方会话的工具调用返回一个**明确错误**,它据此停止再发;对方不会被粗暴丢弃任何消息(消息根本没发出,也就谈不上对方丢消息)。
- 保留一个**软模式**选项(break:'soft'):不抛错,而是在工具返回文本里带一句「judge 判定本轮无意义,建议停止」,由发送方模型自己决定——避免硬中断误伤正当协作。

### 4.5 降级策略(重要)

- judge 模型调用**失败/超时** → **不回退成 break**,而是跳过 judge,让**廉价计数门**继续兜底(即 fail-open 到现有行为)。绝不因 judge 不可用而错误地打断一段正当协作。
- judge 结果只**缓存,不持久化**(stateless,同现有 budget 设计);跨重启由新窗口重建。

### 4.6 异步化

- check 改为 async check(...),在工具 execute 内 await。
- 模型呼叫带上超时 + AbortSignal,超时即走 4.5 降级。

## 5. 成本 / 延迟抑制

    - 宽限:前 6 次(≤ graceExchanges)零模型成本、零干预;从第 7 次起才进入语义判定。
    - 分层:只有超过宽限期+缓存未命中才真正 call 模型;有意义的迭代多命中缓存或停留在宽限期内。
    - 短 prompt:只贴最近 N 条消息与 rubric,不复述整个会话历史。
    - 廉价模型:judge 任务短、不要求强推理,可用独立小模型;缺省则用发送方会话模型。
    - 缓存:同 (from,to) 在 cacheMs 内复用,避免连发 N 次 call N 次。
    - 置信阈值:误判代价 > 漏判代价,所以阈值偏保守(只在 >= 0.75 清晰无意义时才 break)。

## 6. 边界与诚实声明

- 语义判定是不可证明的启发式:可能把「有价值但表达重复」的迭代误判为无意义。**用 reason + 软模式 + 阈值**收敛,不承诺零误判。
- judge 本身花 token:宽限期 + 缓存让它远低于被拦下的循环;极端情况下(大量不同 (from,to) 对同时超过宽限期)仍会有成本尖峰,建议把 graceExchanges 调大或关闭智能层做权衡。
- 只覆盖「本进程内的 s2s 往返」;跨重启的历史丢失,judge 只能基于当前进程窗口。
- 不做「替对方会话做决定/删改」——judge 只在发送方一侧给一个 break 信号。

## 7. 与既有 / 上游的关系

- 复用 S2sBroker 的 message log 作为内容源;复用 dsh-llm 的 prepareCall/stream seam;复用 dsh-agent 的 installModelSelection 绑定发送方会话当前模型。
- 保留现有 maxHops/ratePerMinute 作为**兜底硬上限**,智能层是叠加的「质」守卫。
- 与 dsh-schedule(定时驱动迭代)正交:schedule 负责「周期性拉起继续」,智能预算负责「判定不值得继续则停」。两者可组合:schedule 拉起 + 预算在无意义时 break。

## 8. 工作量与测试锚点

### 工作量(估算)

- 预算服务接线改造成 Service/注入 judge 回调 + check 异步化:小。
- 线程重建(merge records[A]、records[B]、取 window、按 createdAt 排序 + replyTo 拼接):中。
- judge prompt + JSON 解析 + 阈值/缓存:中。
- 降级 & 超时 & 测试:中。

### 测试锚点

- 无意义 ping-pong(重复同一句话 6 次)→ judge 判无意义 → S2S_BUDGET_MEANINGLESS 抛出。
- 有意义的迭代(每次推进方案/出新事实)→ judge 判有意义 → 放行。
- 宽限期(往返 ≤ graceExchanges)不触发 judge;6 次以内完全放行。
- 缓存命中不重复 call(用 fake llm 计数断言 call 次数)。
- judge 超时/失败 → 走计数兜底,不 break。
- 软模式:返回建议停止文本而非抛错。
- 与现有计数预算回归:未配置 semantic 时行为不变(纯计数)。

## 9. 已定决策

1. judge 走 ctx.llm 直呼(一个 PreparedLlmCall + 短 prompt)。
2. break 默认 hard(与现有 fail-loud 一致);soft 作为可选。
3. graceExchanges = 6、window = 6。
4. judge 模型 = 发送方会话当前模型(从 session.requestHeader().config 读);若要覆盖可显式配置 judgeModel。

## 10. 结论

可行。升级为**分层智能预算**(廉价计数门兜底 + 可疑往返才触发模型语义判定 + 高置信无意义则显式 break),默认关闭、fail-open 降级、缓存与短 prompt 抑制成本。它不改变「有意义的连续迭代」,只把「无意义烧 token」抓出来。评审通过后再实现(按插件纪律:方案先行,不先动代码)。
