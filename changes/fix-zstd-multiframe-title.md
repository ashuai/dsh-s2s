## 修复:多帧 zstd 会话日志的标题读取

`collectFromFs()` 的 FS 兜底路径此前**读不到任何磁盘上的会话标题**。

根因:DSH 的 `session.jsonl.zstd` 是**追加写**的,**每帧一次追加**,真实日志动辄上万帧;而原 `decompressZstdAll()` 用单个 `createZstdDecompress()` 流吃下整个 buffer,**只解出第一帧、静默丢弃其余**,且不报错。实测一个 28.9 MB / 81282 帧的会话,只解出 196 字节。

后果:当 `sessionQuery` 不可用时,按名字(session title)解析全部失效 —— 只能靠 `session_id` 定位。

### 修复

- 新增 `scanZstdFrames()`:按 zstd 帧结构(magic + frame header + block header)**扫描帧边界**,不解码 block;对崩溃截断的撕裂尾帧返回 `tornStart` 而非抛错,已写帧仍可用。
- 新增 `latestTitleFromZstd()`:**逐帧** `zstdDecompressSync()` 解码,只保留最后一个 `session/title`;日志不再整体膨胀成一个巨型字符串。
- 结构性损坏的完整帧仍然抛错 → 调用方降级为"无标题",保持原有 all-or-nothing 语义。

### 效果

在本机 235 个会话 / 537 MB 语料上实测:可读标题 **0 → 156**。

### 测试

新增 3 个用例,**多帧输入**下旧实现必然失败:
- 多帧取**最后一帧**的标题(旧实现只读到第一帧)
- 512 帧日志仍能取到末帧标题
- 末帧被截断时,回退到最后一个完整帧的标题

> 此前 3 个既有用例全部用 `zstdCompressSync` 单帧输入,因此该 bug 长期未被 CI 发现。

### CI

新增 `.github/workflows/ci.yml`:push / PR 到 `main` 时在 Node 24 上执行 typecheck → test → build。
