## 修复消息源种类导致历史会话无法加载

把注入消息的来源种类从自定义的 `s2s` / `s2s-lifecycle` / `s2s-schedule` 改为
DSH 内置的 `plugin`(`{ kind: 'plugin', plugin: 'dsh-s2s' }`),并移除自定义事件
`s2s/schedule-change` 及其 session projection。

DSH 会话格式对第三方插件是闭合词表,自定义来源种类/事件类型会让会话在 v0→v3
迁移时被拒绝(报 `cannot safely transform unclassified message source`),导致历史
会话打不开。此改动让新产生的会话可正常迁移与加载。
