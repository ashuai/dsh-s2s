## 兼容 dsh 0.2.x:放宽 peer 范围,并修复"裸挂载即崩溃"

### 问题

1. **peer 范围排除了 0.2.x**:五个 `@deepseek-ai/dsh-*` peer 声明为 `^0.1.0-rc.6`(`>=0.1.0-rc.6 <0.2.0`),于是运行在 0.2.x 上的 harness 在安装/启动阶段直接判定为**不兼容并禁用整行**:
   > `Plugin dsh-s2s@… is incompatible with dsh 0.2.0-rc.1: peerDependencies {…}`

2. **裸挂载必然崩溃**:`apply(ctx, config)` 未给 `config` 默认值,而 `if (config.lifecycle !== undefined)` 直接解引用。任何**不声明 `config` 块**的 profile 行都会得到:
   > `TypeError: Cannot read properties of undefined (reading 'lifecycle')`

   这与该函数自己的文档相反 —— 文档写着 "a bare mount is just the broker + discovery + tools",而裸挂载恰恰是**唯一无法挂载**的形态。

### 修复

- 五个 peer 放宽为 **`^0.1.0-rc.6 || ^0.2.0-rc.1`**,同时保留 0.1.x 支持,不使既有部署失效。`@deepseek-ai/cordis: ^4.0.1` 未变(0.2.x 运行时自带 4.0.4,本就在范围内)。
- `apply(ctx, config: Config = {})` —— 裸挂载恢复为受支持形态。

### 为什么只改版本号不够

改完 peer 后**实际加载**验证发现第二个缺陷:在隔离实例里 `dsh-s2s` 不再被拒,但 `apply` 立刻抛 `TypeError`。仅凭"版本号已匹配"就宣称修好会把一个必然崩溃的插件放进运行时。两个缺陷是叠加的,必须一起修。

### 验证

- **隔离实例加载**:在 0.2.x 运行时下用真实 profile 配置启动,`dsh-s2s` **零告警、零禁用、零 `TypeError`**,`did not activate` 计数为 0。
- **API 表面核对**:本插件 import 的全部 9 个符号(`Service`/`Context`/`SessionId`/`createUserMessage`/`HarnessError`/`BlockAssembler`/`installModelSelection`/`Agent`/`ModelSelection`)在 0.2.x 里均存在,相关包导出清单仅有新增、无删除。
- **回归测试**:新增 2 条裸挂载用例(不传 config、显式传 `undefined`)。二者在修复前均为红。全量 127 测试通过。
