## 修复:L1 只用了投影缓存的一半,导致约一半会话回落到逐条日志读取

### 症状

`s2s_message` / `s2s_resume` 在生产稳定耗时 **4.7 s / 3.5 s**,且**第二次调用同样慢**(缓存已落盘也不改善)。

### 根因

宿主的会话列表(`dsh-api-session-controller/lib/index.js:2010-2012`)查的是**两个 face**:

```js
seq   = sessionProjections.cachedSnapshot(session)              // live 会话
cached = cache.cachedSnapshot(header) ?? cache.cachedPredecessorTitle(header)
```

本插件**只用了第一个** `cachedSnapshot(header)`。当前检查点没有 title 行的会话因此全部落到 `sessionQuery.readTitle(id)` —— 那是一次**完整日志读取 + 解压 + fold**。

实测(238 会话语料):单次 `readTitle` **39.4 ms**;4.7 s ÷ 39.4 ms ≈ **119 次回落**,与"约一半会话无当前检查点行"吻合。这也解释了为什么 L0 缓存落盘后仍然慢 —— 它缓存的是**读取结果**,而未命中是**结构性**的,每次都要重付。

### 修复

`readTitleFromL1` 改为与宿主同序的两级:

```ts
projection.cachedSnapshot(meta, ['title'])
  ?? (typeof projection.cachedPredecessorTitle === 'function' ? projection.cachedPredecessorTitle(meta) : undefined)
```

接口 `SessionProjectionCacheLike` 增加**可选** `cachedPredecessorTitle`,缺失即跳过(能力探测,老宿主不受影响)。

### 测试

新增 3 条:①当前检查点无行时由 `cachedPredecessorTitle` 作答且**零逐条读取**;②前任行无标题也算答案,不算 miss;③两个 face 都不作答时才回落读取,且**只读那一个**。全部 125 测试通过。

### 诚实声明

本次**未测** `sessionQuery.listSessions()`(枚举 238 个会话)自身的成本。若它本身就耗时数秒,则本修复只消除"回落读取"那部分,总耗时会低于 4.7 s 但未必到 ms 级。下次实测应把这两项分开计时。
