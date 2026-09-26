## 修复:构建产出陈旧产物(tsc 被漏跑),导致多个修复根本没有进入 bundle

### 症状

连续三个修复(短 id 显示、缓存落盘、L1 前任 face)提交、CI 通过、Release 正常,但宿主重启后**行为毫无变化** —— 看起来像"代码不对",实际是**产物根本没更新**。

### 根因

`tsdown` 打包的输入是 **`lib/types/**`(tsc 的产物)**,不是 `src/`。因此:

```
tsdown            → 把上一次 tsc 的旧结果重新打包一遍
tsc && tsdown     → 正确
```

我在若干次构建中只跑了 `tsdown`,于是**每一次都重新发出了上一版的 bundle**。因为产物确实被"重新生成"了(时间戳变新、大小略变),所以肉眼与 CI 都看不出问题。实测确认:`lib/index.js` 里 `cachedPredecessorTitle` 标记数为 **0**,而源码里存在。

### 修复

1. `package.json` 的 `build` 改为 **`tsc -p tsconfig.json && tsdown && node scripts/verify-bundle.mjs`** —— 单一入口,顺序不可能再错;
2. 新增 `scripts/verify-bundle.mjs`:**构建后断言 bundle 含有一组"只有对应源码入选才存在"的标记**(`cachedPredecessorTitle` / `shortId` / `onPersistError` / `dsh-s2s`),缺一即**以非零码失败**,并提示"是不是漏跑了 tsc";
3. CI 已在跑 `pnpm run build`,因此这条断言进入流水线 —— 陈旧产物今后会在 CI 就被拦下。

### 意义

这是本仓库第二次因"产物形态 ≠ 真实形态"而长期掩盖问题(前一次是 zstd 测试只用单帧输入)。区别是这次加上了**机械化门禁**,而不是靠人记得跑对命令。
