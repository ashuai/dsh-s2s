## 修复:v4 会话格式拒绝消息,报 `producer-owned source kind`

DSH 0.1.7-rc.2 的会话格式 v4 **在写入admission 就拒绝** `{ kind: 'plugin', … }`:

```
Error: format v4 message requires a producer-owned source kind
```

校验点(`dsh-session-persistence-jsonl/lib/worker.cjs`,写入路径 `assertV4MessageSources`):

```js
if (!isJsonObject(v) || typeof v.kind !== 'string' || v.kind.length === 0
    || v.kind === 'plugin')
  throw new SessionFormatError("format v4 message requires a producer-owned source kind")
```

v4 把「插件所有权包装」退休了,**每个生产者必须在自己的模块里声明 kind**(类型定义原话:*"each producer declares its own `kind` in its own module; there is no shared catch-all `plugin` kind"*),官方插件已全部改完:`schedule` / `plan-mode` / `time-context` …

### 本插件的缺陷

三处注入都在用已废弃的包装,于是**每一次投递都让目标会话整轮 turn 打挂** ——`s2s_message`、`s2s_resume`、`s2s_schedule` 全部命中:

```js
source: { kind: 'plugin', plugin: 'dsh-s2s' }   // 旧
source: { kind: 'dsh-s2s' }                     // 新
```

失败时机:turn 的第一个落盘事件 `agent/inbox/spliced` 携带该消息 → admission 不过 → 整批不写。所以目标会话日志会干净地停在上一轮 `turn/end`,**连 `turn/start` 都不留**;会话文件本身不受损,可直接打开,但任何 s2s 投递都会被立刻打回。

### 修复

- 新增 `src/source.ts`:按官方模式做**声明合并**,并导出单一常量
  `S2S_MESSAGE_SOURCE = { kind: 'dsh-s2s' }`(与 `dsh-schedule` 的 `runtime.d.ts` 同构)。
- `broker.ts` / `lifecycle.ts` / `schedule.ts` 三处改为引用该常量,消除重复引入旧写法的可能。
- `types.ts` 里把旧约定("use the built-in `plugin` source kind")的注释改为现状说明,避免后人回退。

### 测试

- 既有断言更新为 `kind === 'dsh-s2s'`,并断言 **`plugin` 字段不存在**。
- 新增 2 条回归断言,分别钉住 live 投递(`broker`)与静止会话 drain(`lifecycle`)两条路径,
  明确断言 `kind !== 'plugin'` —— 这条规则一旦回退,整个 s2s 投递面立刻全废。

### 验证

- 99 测试通过,`tsc --noEmit` 干净(借助声明合并,不再依赖已被移除的 `plugin` 成员)。
- 端到端:构建产物的 `S2sBroker` 实际投递得到的 source 为 `{"kind":"dsh-s2s"}`,
  通过 0.1.7 的真实 admission 规则;旧的 `{kind:'plugin',plugin:'dsh-s2s'}` 被拒。
