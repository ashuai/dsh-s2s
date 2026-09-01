# dsh-s2s 经验教训(踩坑实录)

> 踩过的坑 + 已验证的正确做法,供后续与 subagent 复用。所有结论都有实测证据。

## L1. 装新插件必须用 `insert:` 形式(最重要)

- **现象**:`- id: dsh-s2s + name: ./... + config` 让补丁报 `patch: entry "dsh-s2s" not found` 并被**静默跳过**。
- **根因**:`dsh-app-boot` 的 `applyEntryPatches` 里,非 `insert` 行只 **patch 已存在 entry**(`entryMap.get(id)`);新插件的 id 不在 bundle 树 → warn + continue → 不加载。
- **正确**:`- insert: [ { id, name, config } ]`。
- **连带发现**:用户的 `extra-writable-roots` 也一直是这样(非 insert)→ **从未真正加载**;改成 insert 后又暴露依赖 `sandbox/fs` 服务而 pending。属用户既有配置,另行处理,勿与 s2s 混测。

## L2. `name` 必须是可解析的 ESM **入口文件**,不能是目录

- **现象**:`name: ./dsh-s2s` → `ERR_UNSUPPORTED_DIR_IMPORT`。
- **根因**:loader 对 `name` 直接 `import('<name>')`,node ESM **不支持目录 import**(不自动解析 package.json 的 main)。
- **正确**:指向产物文件 `./dsh-s2s/lib/index.js`(插件需先 `pnpm run build` 产出 lib)。extra-writable-roots 同理 → `index.js`。

## L3. 加载测试必须隔离,绝不碰主用 web profile

- **红线(写入 AGENTS.md)**:主用 `~/.dsh/profiles/web`(端口 3080)+ 用户前台进程,严禁修改/强杀。
- 测试用:独立 `DSH_HOME`(如 `/tmp/dsh-s2s-test`)+ **新端口**(4099/43124 等)+ 全新 `storages`;验证完**立即杀**。
- **踩过**:前两轮为验证动了主用 profile/进程,导致用户重拉两次 GUI——不可再犯。

## L4. 后台受限 job 跑**完整 web 应用**会挂起

- **现象**:`dsh --profile web`(即使隔离 home/新端口)在后台 job 里 0% CPU、无 LISTEN、无输出地挂起(首个能亮端口的是 hub 探针与轻量 boot)。
- **根因(推断)**:后台子进程文件沙箱仅 workspace-write,web 启动过程中的某些写/交互被挡或等待;不是插件问题(插件 import 已越过、且 65 测试全过)。
- **建议**:验证"插件是否载入"用**轻量信号**——开 `hub.server` 探针端口(404=在监听),或在**前台终端**由用户跑;不要指望受限后台把整个 web 拉起来。

## L5. 同宿主场景:上游 hub+WS 是跨主机层,进程内 broker 更优雅

- 上游 @dpskh/a2a 的 hub server + WebSocket 是为**跨进程/跨机** DSH mesh 设计;同宿主单进程用它开监听端口属"用跨主机工具干同进程活"。
- 更优雅:进程内 `S2sBroker`(cordis 服务)直取 `ctx.agents.get(目标sessionId)` → `followup/inject` 投递;**零端口**;配合现有 mailbox + `AgentRegistry.resume`。
- 默认配置 `hub: {}` 已实现 0 端口;broker 可作为下阶段把同宿主路径彻底"去 WS"的设计(见 SOLUTION §R5)。当前测试/线上基线不依赖监听端口。

## L6. 环境与锁定

- 验证环境:pnpm 12.1.0 / node 24(macOS arm64);shell 默认 PATH 时常为 `undefined`(显式 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)。
- 目录 import 失败与 lockfile 重解析均已适配;构建 `pnpm run build` 产出 `lib/index.js`。
