# Change fragments

一个目录,专门放**发布说明片段**(release-note fragments)。往这里**新增一个 .md 文件**就会触发 GitHub Action,自动打一个 Release,把这些片段的正文拼进 Release Body。

样式仿 changesets / beachball:一次改动一个小文件,发布时合并。

## 约定

- 目录:`changes/`
- 每个文件是一个**独立的 markdown 片段**,文件名 = 该改动的短标识(如 `add-s2s-schedule.md`)。
- 内容 = 要写进 Release 的正文(markdown 可用)。标题用 `##` 会被按文件名拼出来;也可在片段内自带标题。
- `README.md` 不会被当成片段。
- 只在 `main` 分支的 push 且**新增**文件时触发;删除/修改不会重复触发,清理片段也不会造成死循环。

## 片段示例

`changes/add-s2s-schedule.md`

    ## 新增 s2s_schedule 定时注入
    
    新增 s2s_schedule 工具:list / create / cancel 三个动作,按 every_seconds 周期或 at_iso 单次,把提示注入目标会话。
    
    ### 用法
    
    - 通过 s2s_schedule 工具创建周期任务
    - 浏览器「计划 / Scheduled」tab 展示当前活跃任务

## 发布时会发生什么

1. 检测到 `changes/` 下新增片段 → 触发 `.github/workflows/release.yml`。
2. 读取所有片段正文,按文件名(去掉 .md)当二级标题拼进 Release Body。
3. 读 `package.json` 的 `version`,把**最后一段数字 +1**(`0.4.0-s2s.0` → `0.4.0-s2s.1`),写回并打 `v<新版本>` tag。
4. `gh release create` 生成 GitHub Release(tag 与 body 如上)。
5. 把已消费的片段 `git rm` 掉并提交,下次只发新增的。

手动也可:在 GitHub 上对本 workflow 点 Run workflow(`workflow_dispatch`),会忽略「新增文件」判断,直接把当前 `changes/` 剩余片段发一版。
