# 上游 fork 对比分析与移植计划

> 2026-11-22 · 基准：上游 `deepseek-ai/dsh-superagent-prototype` 单提交（8c32a9d，发布后零迭代）· 我们：`gitlab-source` 分支
> 筛选口径：3007 个 fork 中，star>0 或近两周有真实领先提交者逐一查 diff。结论：有实质内容的只有 4 个。

## 总览

| fork | 领先 | 核心内容 | 对我们的价值 | 移植判定 |
|---|---|---|---|---|
| chenhuang444 | 9 commits / 122 文件 | GitLab forge 全套（含 MR 生命周期）+ forge 抽象 + CI 监视 + openspec 流程 | ★★★★★ 正面撞车，深度超过我们 | 移植 M5 + 流式摄入 + CI 摘要 |
| lanshi17 | 7 commits / 22 文件 | 微信 iLink 源 + portal 常驻 team-lead + worker 池自适应 | ★★★ 唯一的新来源实现 | 移植 weixin 源（新插件） |
| tonbiattack | 17 commits / 55 文件 | issue 驱动 autopilot（标签门禁 → 实现 → PR → 验证后自动合并） | ★★★ 工程范式最严谨 | 暂不移植，理由见下 |
| flowioo | 2 commits | worker 模型选择键改名修正 + Router 可委派子代理 | ★★ 小而准 | 版本升级时再带；委派是配置项不移植 |

## chenhuang444/dsh-superagent-prototype（重点）

### 它做了什么
- **完整 GitLab forge**：`gitlab.ts / gitlab-channel.ts / gitlab-mr.ts / gitlab-read.ts / gitlab-trigger.ts` 五件套，单项目。
- **forge 抽象层**（`src/forge/types.ts`，`FORGE_KINDS = ['github','gitlab']`），GitHub/GitLab 走同一接口；另有 Gerrit forge 的 openspec 设计稿。
- **openspec 多实施者流程**：design.md 作为三个实施者（core/source/docs）之间的契约，签名冻结。
- 对标 DSH 0.2.2-rc.2。

### 架构上比我们强的一点：流式摄入取代 todo 依赖
他们的 `pollStream`：对 issues 和 merge_requests 两条流分别按 `updated_after` 游标拉取，**每个有更新的条目直接读它的 notes**（未订阅线程只看 @提及，订阅线程全读）。这从根本上不依赖 todos——绕开了 Sidekiq 异步延迟（我们实测分钟级），也天然覆盖「重复 @ 无新 todo」场景。我们的 todo 监听（todo 队列）+ notes 监听（pending todo 线程）双通道能用，但是被动的补位；他们的是主动的流。

### gitlab-mr.ts = 我们的 M5，可直接借（需要多项目适配）
`github-pull.ts` 的 GitLab 全译本，~150 行：
- `MrSchema`：带 `head_pipeline`（只有单条 MR 端点带）、merge_when_pipeline_succeeds、draft、labels。
- `claimMr(ctx, ticketId, mr)`：MR 绑定工单——源 MR 或机器人从工单分支（最后一段=DSH_SUPERAGENT_NAME）开的 MR；一个 MR 只能属于一个开工单。
- `observeMr(ctx, mr)`：轮询驱动状态对账，merged/closed → `threadClosed` → 工单收尾；auto-merge 事实写线程卡片。
- `mrEndNotices`：工单随 MR 终结后向其他渠道（如飞书）发幂等终态通知，中文/英文按内容判别。

**适配点**：他们线程 id 是 `mr:N`（单项目），我们是 `gitlab:<project>:mr-N`（多项目）；`commands.gitlab(schema, path)` 要换成我们的 `glabApiOn(project, ...)`；`gitlabOf(deployment)` 单账号假设要映射到我们的 forge 解析。逻辑可照抄，接口要换皮。

### 顺带捡的
- `--paginate --output ndjson` 分页（已采纳，替代我的正则拼页，32/32 测试绿）。
- CI 摘要：轮询 MR 时带 `head_pipeline` 状态进线程事实，面板可见流水线红绿灯。

## lanshi17/dsh-superagent-prototype
- `src/sources/weixin.ts`（183 行）：微信 iLink 长轮询源（ilinkai.weixin.qq.com），游标持久化、Trigger 落库后才推进游标。带 116 行测试。**移植为独立来源插件即可**，与我们的 GitLab 源同构。
- `src/app/portal.ts`（193 行）：常驻 team-lead——飞书消息可当 portal 会话入口，主会话委派 worker。与 flowioo 的「Router 可委派」思路同源。**这是产品方向改动，先不动**，评估后再定。
- worker 池按机器规格自适应：小改动，值得顺手带。

## tonbiattack/dsh-superagent-prototype
- issue 驱动 autopilot：`autopilot` 标签门禁 + 允许名单作者 → 自动实现 → 验证（最多重试 3 次）→ 开 PR → 分支保护通过后**自动合并**。耐用队列、每仓一工、重启对账（job 键=不可变 repo ID，改名不丢）、锁放在检出目录。
- **暂不移植的理由**：① 它针对 GitHub 源，且引入「自动合并」这个我们明确不想要的风险动作（我们的交付纪律是只开 MR 等人审）；② 与 Router/Policy 的既有接单流有大量职责重叠，移植=再造一套接单器；③ 值得学的是范式（fail-closed、结构化证据、重启对账），不是代码。若将来要「全自动模式」，按其 docs/009 规格重写比搬代码更干净。

## flowioo/dsh-superagent-prototype
1. `modelSelection/modelDiscovery` → `modelSelectionSettings`：dsh-tool-subagent 插件在某版本改了配置键名。**我们当前 DSH 0.2.2-rc.1 上 worker 派生正常，说明旧键在我们的版本仍有效**——不急着改，升级 DSH 时对照处理。
2. Router 预设加 subagent 工具（Router 路由不了的自己委派）：纯 cordis.patch.yml 配置项，我们面板里想开就开，不写进代码。

## 移植顺序（按价值/成本比）
1. ✅ ndjson 分页（本轮已完成）
2. **M5：gitlab-mr 多项目移植**（gitlab-mr.ts 换皮 + MR 流观察 + 终态通知）
3. **流式摄入**（pollStream 思路进我们的源：per-project issues/MRs updated_after 流 + mention 过滤，吃掉 pollOpened 和 todo 盲区的根）
4. CI 摘要进线程事实（跟随 3 顺手带）
5. weixin 源插件（独立目录，不影响现有）
6. worker 池自适应（小补丁）
