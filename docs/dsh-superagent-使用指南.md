# dsh-superagent 使用指南

> 面向已部署好 dsh-superagent 的运维工程师。只讲「怎么用」，不讲「怎么实现」。
>
> **事实来源约定**：本文以仓库内文档为唯一事实来源——README.md、SETUP.md、docs/000 ～ docs/008，每节标注出处（如「出处：docs/002」）。文档未覆盖的地方明确写「文档未覆盖」。唯一例外是**本 fork 新增的 GitLab 源**：上游文档仅在 docs/007 架构表里提及，其使用细节取自源码（src/sources/gitlab.ts、cordis.patch.yml、skills/dsh-superagent-gitlab/SKILL.md），并在第 8 节单独标注。
>
> **先记住一句话**：dsh-superagent 是**研究原型，不是 DeepSeek 官方产品**，可能仍有 bug，生产使用前先评审与适配（出处：README.md）。

---

## 1. 它是什么、适合什么场景、设计原则

出处：README.md、docs/000、docs/001、docs/007

### 1.1 它是什么

dsh-superagent 是一个**主动编码代理（proactive coding agent）**，打包为 DeepSeek Harness（DSH）的插件 bundle，监听一个代码仓库（上游为 GitHub；本 fork 增加 GitLab），可选监听飞书群。当**被授权的人**向它提出工作时，它：

1. 开一个**工单（Ticket）**；
2. 在**独立的 Executor Session 和独立目录**里干活（每个工单一个 Session，名为 `worker-<工单 id>`）；
3. 在**原来的对话里**交付结果——通常是一个 PR/MR；
4. 全程由一个 **Web 面板**告诉你「哪里需要人」。

架构上是 **Router/Worker 双层**（出处：docs/004、docs/007）：

- **主 Session（Router / orchestrator）**：只做路由——评估 Trigger、接单/停止/忽略、派发工单、回话。它**不做任何技术决定**，一次路由调用可携带多个决定。
- **Executor Session（Worker）**：每个工单一个，读原始上下文、判断范围、实现并验证。

### 1.2 数据流（一张图看懂）

出处：docs/001

```
Source（来源：GitHub/GitLab/Feishu）
  → Trigger（触发：一条不可变事件）
  → Thread（线程：按时间排序的 Trigger 序列）
  → Eval（评估：gate 准入 + assessment 研判 两层）
  → Decision（决定：accept 接单 / stop 停止 / ignore 忽略 / unavailable 未完成）
  → Ticket（工单，携带 Mandate 授权）
  → Assignment（派工：工单绑定到某个 Executor）
  → Executor 干活 → 经 Channel（渠道）回到 Source 回复
```

### 1.3 适合什么场景

- 团队希望有一个「随叫随到但不抢话」的自动化成员：在 Issue/MR 里 `@它` 提需求，它开分支、写代码、回 PR，人在原对话里验收。
- 想让**明确授权的小圈人**能直接派活，同时把其他动静（新 Issue、评论、CI、bot 消息）先「只记录不行动」，观察成熟后再逐步放权。

### 1.4 设计原则：占用最少人注意力

出处：docs/000

核心原则：**「占用尽可能少的人注意力，产出尽可能多的价值。」** 每条消息、每个面板元素都要值回它消耗的注意力，否则就被移除。由此推出：

- **只在被问到、或团队写下的规则允许时才行动。** 请求必须是「被允许的人直接对它说话」；没人要求的主动工作必须命中团队写的规则，且从「只记录」模式起步。
- **只在「人必须行动」或「人能用上结果」时才说话。** 接单确认一次；干活时保持安静；结果就绪、需要决定、或无法完成时才再开口。消息简短，发回原对话。
- **一次只问一个具体问题**，用结构化表单提问，不让问题埋进长报告。
- **按影响停止，不按工作量停止。** 局部改动做到可评审的结果；需要设计决策就停下来问清楚。
- **诚实汇报。** 草稿标记为未完成，失败就报失败，永不为了「不问人」而绕过限制。

对面板与配置的设计推论：概念少、设置少（行为用提示词文字描述而非加开关）、面板只显示需要人的东西（健康状态不占地方）。

**运维者责任（三条铁律，务必记住）**（出处：docs/000 Responsibility）：

1. **Start narrow（从窄开始）**：短允许名单 + 主动工作只记录，观察「它本来会做什么」靠谱后再放宽。
2. **Tune for less noise（向少噪音调）**：它吵的时候，把提示词改得更短更严，或者暂停它；**不要**加更多消息去解释噪音。
3. **Own what it says（为它说的话负责）**：它以你们团队看得见的账号发言，每条消息都消耗同事的注意力。读它以你的名义发的东西，说错了就改提示词纠正。
4. （附加）**不要拿它刷量**：批量 PR、广播消息、瞎忙活对团队是净损失。

---

## 2. 点亮：部署/账号/仓库配置的最小步骤

出处：README.md、SETUP.md、docs/006

### 2.1 推荐路径：让 coding agent 带你装

README 的官方建议：对你的 coding agent 说——

> 读本仓库的 SETUP.md，带我安装 dsh-superagent。

SETUP.md 规定了安装流程：先跑一次探针（检查 Node 22.19+/24+、pnpm、git 2.32+、tmux、Python 3.8+、gh 2.48+、DSH 版本在 package.json 的 `engines.dsh` 范围内、模型 provider 已配置），然后**一次只问一个短问题**（来源、仓库、agent 账号、允许名单、检出方式、提交身份、auto-merge），收齐后给一份完整计划，你确认一次，它才开始执行。**密钥永不在聊天里索要**——建账号、登录 CLI 这类必须人动手的步骤，会汇成一条消息给你精确命令。

### 2.2 账号层（最小心智负担的要点）

出处：docs/006 Accounts

- **Agent GitHub 账号**：必须是一个**专用的普通用户账号**（不能是 GitHub App，因为要读它的 notifications），给它对目标仓库的写权限。它的一言一行都以这个账号出现——**绝不用运维者自己的账号**（SETUP 问题 3）。
- **CLI 隔离**：用 wrapper 脚本给 agent 账号独立的 `GH_CONFIG_DIR`（如 `~/.local/bin/gh-agent`），保证这个 CLI 只持有 agent 的凭证。Feishu 同理用 `lark-cli` wrapper（`LARKSUITE_CLI_CONFIG_DIR` 独立目录 + strict-mode bot）。本 fork 的 GitLab 用 `glab` wrapper（见第 8 节）。
- **安装与 profile**（docs/006 Install）：独立 DSH profile（默认名 `superagent`，面板端口默认 `3082`），与你自己工作的 profile 分开——插件会改进程级 PATH 和 git 配置，且需要独立重启。`dsh superagent --from-default-profile web` **只在首装时跑一次**；profile 已存在时再跑会**替换它并删掉 cordis.patch.yml**。
- **机器配置**：把 `examples/profile.cordis.patch.yml` 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换占位符。`stateDir` 必填（绝对路径）：里面放数据库、锁、worker-bin 命令 shim、agent 的 git 配置，以及默认的工单目录 `work/`。**升级前备份它**。用 Feishu 时还要启用 `dsh-superagent-feishu` 条目；本 fork 用 GitLab 时启用 `dsh-superagent-gitlab`（见第 8 节）。

### 2.3 面板里的四步设置

出处：docs/006 Settings

启动（`scripts/dsh-superagent start`）后，打开日志里打印的 URL，点侧边栏 **Superagent**。Overview 会列出还缺什么并链接到对应设置。按顺序：

1. **Sources**：GitHub 卡片填仓库（`owner/name`）和 agent CLI 路径（如 `/home/me/.local/bin/gh-agent`）。请求通常经 agent 账号的 notifications 到达；默认轮询周期 1 分钟。
2. **Policy（Settings → Eval → On each Source）**：把**可以派活的 GitHub login / 飞书用户**加进允许名单。**名单空着 = 任何请求都成不了工单**——这是最常见的「@了没反应」原因。飞书可选一个群做名单同步（启动时和点 Sync now 时同步）。
3. **Execution**：目录根 + prepare 命令（典型做法用 `git worktree` 为每个工单建检出，docs/006 给了完整示例命令；分支前缀默认 `agent/`）。把**你个人的 CLI**（登录你自己账号的那些）列进 blocked commands。
4. **Prompts**：设置团队段——GitHub 披露行（默认 `This is by an automated agent, not a human`）、哪些普通账号是 review bot、提交作者、auto-merge 条件（默认不开）。

### 2.4 验证点亮

出处：docs/006 Try it、SETUP.md 第 5 节

- `scripts/dsh-superagent status` 退出码 0 = 服务正常（退出码含义见第 6 节）。
- 用一个**在允许名单上的账号**，在仓库 Issue 里发一条评论：`@<agent 账号> <你的请求>`。约一个轮询周期（默认 1 分钟）内，Overview 应出现一个工单；agent 会先确认接单，然后在自己的 Session 和目录里干活，结果回原对话。
- ⚠️ **已知坑**：在 GitHub 上**编辑已有 Issue 正文加 @ 不会被收到**；要用**新评论** @（出处：docs/006 Settings 与 Troubleshooting 末行）。

### 2.5 每小时自检（建议装上）

出处：docs/006 Hourly check

在**你日常用的 DSH profile**（不是 superagent profile）里建一个每小时计划任务，提示词用 docs/006 里的原文（填入 checkout 路径）。它的逻辑：status 退出 0 什么都不说；退出 2/3 只报告不重启；退出 1 才用 `--respect-stop restart` 尝试自愈（人工 stop 过的不会误拉起）。

---

## 3. 日常四件事：派活、盯活、验收、叫停/纠正

### 3.1 派活：怎么提请求才算「明确请求」

出处：docs/002「Two paths for a Trigger」与「Strength」

主机对每条消息记录它是否**直接对 agent 说话**（GitHub 上 `@agent 账号` 为 `mention`；飞书里 @bot 或私聊为 `mention`/`direct`），然后 gate 按发送者和 Policy 判定强度：

| 强度 | 构成 | 效果 |
| --- | --- | --- |
| **explicit（明确）** | 允许名单上的人直接 @ agent；或在已有工单的 Thread 里跟进；或 admission 表某格设为 explicit | **任何 accept 模式下都会被受理**，可直接路由接单 |
| **inferred（推断）** | 名单外的人在已有工单的 Thread 跟进；admission 表格子设为 inferred；名单内 bot 的消息 | 需要模型完整研判，且受 accept mode 约束（见第 4 节） |
| **not admitted（不受理）** | 其他 bot、admission 表忽略的、accept mode 为 `off` 时的一切 inferred | 不成为候选 |

**给团队的派活话术**（对照默认提示词原则，出处：docs/004）：

- 直接 @ agent 账号，把**对象和期望结果**说清楚（它会先确认一次「要做什么、预期产出什么」再动手）。
- 后续补充**直接在同一 Issue/MR 下回复即可**——工单订阅了 Thread，后续讨论**不需要再 @** 也会送达它的 Executor（出处：docs/001 Subscription）。
- 已结束但未被人工停止的工单，人在它的 Thread 里发消息会在**原 Mandate 下直接恢复**，不走新一轮评估（出处：docs/002 Resume and stop）。

### 3.2 盯活：面板各区看什么

出处：docs/005

打开 DSH Web 侧边栏 **Superagent**。面板按三个问题排序：**① 现在有东西需要我吗？② 系统健康吗、在做对的事吗？③ 某项工作从 Trigger 到 Ticket 的履历？**

| 页签 | 看什么 | 什么时候看 |
| --- | --- | --- |
| **Overview** | 需要人处理的工单、系统问题、最近 24h 活动计数、Executor 负载；每块都链到详情页 | 每天第一眼；setup 未完成时这里列出缺什么 |
| **Source** | 各 Source 状态、setup 问题、被过滤的 Trigger、被丢弃的消息（24h 窗口，与 Overview 一致） | 「@了没反应」时先查这里：消息是不是被过滤了 |
| **Trigger** | Thread 列表（可按 Subscribed / Evaluating / 24h 新 Trigger / 全部过滤），每个 Thread 的 Trigger、Decision、Subscription | 追溯一条消息的去向（Disposition） |
| **Eval** | 每条 Decision 及其理由、命中的规则 | 想知道「它为什么接/为什么不接」时 |
| **Execution** | Executor 状态、**Pause processing** 开关、工单列表（Open / Pending / Working / Waiting for a Trigger / Ended 过滤）；工单详情含操作、授权、等待的 Input、订阅、派工记录 | 日常盯工单、停止/重试 |
| **Settings** | Sources / Eval / Execution / Prompts / Deployment 五组，各带保存历史 | 改配置 |

**工单阶段**（出处：docs/003 Ticket stages，自上而下取第一个命中的）：

| 面板标签 | 含义 | 你需要做什么 |
| --- | --- | --- |
| Input undelivered | 给 Executor 的输入投递失败，自动退避重试中 | 持续不消失时用工单上的 **Retry** |
| Awaiting answer | 工单上有一个**待人工决定（Attention）**的问题 | 回答它的问题（在原对话里） |
| Awaiting review | 最新报告是 `ready`（且带 PR） | **验收点**：评审 PR/MR |
| Blocked / Failed | 最新报告 `blocked`/`failed`，且此后没有人的消息 | **验收点**：发一条消息指导它，或点 **Retry** |
| Queued | 等 worker 槽位 | 一般不用管；长期排队查并发设置 |
| Waiting for a Trigger | 空闲：这一轮做完且无未决问题，订阅 Thread 的新动静可唤醒 | 不用管 |
| Working | 正在干活 | 不用管 |

要点：**`person/*` 阶段 = 没有人输入它走不下去**；`blocked`/`failed` 的工单收到一条人的消息就会放行回 working（出处：docs/003）。头部搜索支持 Trigger 文本/id、飞书消息 id、GitHub 链接、`#12` 这类引用。

### 3.3 验收：工单生命周期与人工验收点

出处：docs/001、docs/003、docs/005

**生命周期**：工单只有 Eval 能创建；`open → ended`；人的消息可把它拉回 open，**除非它是被人 stop 的**。工单结束不代表授权失效——Mandate 仍在，人的消息可在原授权下恢复它（恢复前会按当前 Policy 重新校验，见第 4 节）。

**Executor 的六类报告（Report）**（出处：docs/001 术语表）：`progress 进展`、`waiting 等待`、`ready 就绪`、`blocked 受阻`、`failed 失败`、`dropped 无需处理`。

**工单怎么算完**（出处：docs/003 How a Ticket ends）：

- 无 PR 的 `ready` → 完成。
- `dropped` → 无事可做（比如需求不复现、已被取代），工单静默结束（除非命中的规则要求说一句），之后人的消息仍可恢复。
- 有 PR：工单跟随它开过的所有 PR，**全部不再 open**（合并或关闭）时按最后一个关闭结果结束。结束时保留订阅，人之后的评论仍可恢复它。「Awaiting review」实际含义 = ready 报告 + 有 PR 待你评审。

**三个人工验收点**（对照上节阶段表）：

1. **Awaiting review**：评审 PR/MR——合并还是要求修改，直接在 PR 里写评论，它会收到并继续。
2. **Awaiting answer**：回答它通过 `human_action` 提出的具体问题；已获授权的工作在等待期间仍可继续。
3. **Blocked / Failed**：它明确说自己卡住了。给一条指导消息（即放行），或在面板上 Retry（同一 Session、目录、分支、PR 上开新派工，出处：docs/003 Retry）。

**评审意见怎么处理**（默认提示词原则，出处：docs/004）：已修复并验证的评论会被静默 resolve；拒绝的给一句理由；自动评审 bot 每个 PR 最多三轮。如果人的分支/PR 已包含同样改动，它会**关掉自己的 PR 并让路**（一句话指向你的 PR）。

### 3.4 叫停与纠正

出处：docs/002、docs/003、docs/005

| 你想做什么 | 怎么做 | 后果 |
| --- | --- | --- |
| **停掉一个工单** | 面板工单详情 **Stop**（是命令，记为人工停止）；或在 Thread 里说 stop（这是普通 Trigger，由 Eval 决定停止） | 人工 stop **撤回 Mandate**：工单保持 ended，**从此收不到任何消息**；那里再要干活必须重新产生一次 accept。Executor 自己**不能**宣布「人让我停」 |
| **重试卡住的工单** | 工单详情 **Retry**（Input 投递失败、或 blocked/failed 后等人时可用） | 结束当前派工，同一 Session/目录/分支/PR 开新派工，带上等待中的输入 |
| **全部暂停** | Execution 页 **Pause processing** | 停止派发、新 Eval、Eval 超时、输入投递和回复；**Source 照常记录 Trigger，运行中的 turn 不被打断**；暂停期间 Eval 不过期（deadline 顺延），人给已结束工单的消息会等到恢复后第一趟再处理 |
| **改策略/规则** | Settings → Eval 改 accept mode、规则、各 Source 的名单/admission 表 | 产生新 Policy version：进行中的 Eval 作废重排；**受影响**的存活工单收到 policy-changed 通知（命中的规则变了/不再适用、请求者失去资格、主动工作不再接受），但**不立即撤销**其 Mandate；已结束工单恢复前会按新 Policy 重新校验，可能因此**撤销** Mandate |
| **纠正它说错的话** | Settings → Prompts 改对应团队段或内置部件 | 见第 5 节；不要靠在原对话里跟它吵架来纠正 |
| **把一条被 Executor 持有的跟进消息送交重新评估** | Thread 详情 **Evaluate again** | 见 docs/005「Reading individual records」；也可对没有有效判定的 Trigger 重评 |
| **退订一个 Thread** | 面板 unsubscribe | 丢弃该 Thread 上全部订阅；各工单仍处理已收到的跟进（docs/007 Engine 表 `unsubscribe`） |

---

## 4. 授权体系：怎么配才既安全又不饿死它

出处：docs/002（主）、docs/000、docs/006

### 4.1 四个旋钮

1. **允许名单（allowed list）**：每个 Source 各自的名单，用**该 Source 自己的身份**（GitHub login / 飞书 open_id；不同 Source 的身份永不互映）。名单上的人 @ agent = 明确请求，任何模式都受理。**名单为空 = 谁也派不动活**（docs/006 Settings）。
2. **accept mode（接单模式）**：

   | 模式 | 效果 |
   | --- | --- |
   | `off` | 一切推断候选都不受理（未 @ 的消息、bot 消息、名单外跟进） |
   | `observe`（默认） | 推断候选照常研判，但**只记录**「would accept」，不接单 |
   | `auto` | 研判为正的推断候选**真的接单** |

   **明确请求在任何模式下都受理。** 官方路径：先 `observe`，审阅记录下的 Decision，觉得「它本来会接的都接对了」再切 `auto`（docs/002 Accept mode and rules、docs/000 Start narrow）。
3. **Policy 规则（rules）**：每条规则描述**一类主动工作**。主动接单必须至少命中一条启用规则；每次研判对每条启用规则都判一次（命中与否都判）。工单的 Mandate 记录命中的规则，Executor 只收到这些规则的名字和指令，且**该规则里写的流程与沟通要求会覆盖默认值**（如某规则要求静默不确认、或指定合并前的审批人）。对**所有**工单都适用的要求请写进团队提示词段，而不是规则（docs/002）。
4. **admission 表（每个 Source 一张）**：行是「接收范围」（GitHub：新 Issue / 新 PR / 评论 / 默认分支 CI；飞书：各配置群、其他群、私聊）。每行至多三格，决定消息成为明确请求、推断候选、还是忽略：

   | 格子 | 可选 | 默认 |
   | --- | --- | --- |
   | 名单内、未 @ agent | inferred / ignore | inferred |
   | 名单外、@ 了 agent | explicit / inferred / ignore | ignore |
   | 名单外、未 @ | inferred / ignore | ignore |

   - 「未 @」两格只在 Source 接收全部消息时可用（GitHub 打开对应 receive-all 开关 / 飞书群设「全部消息」）。CI 没有发送者，只有第三格。
   - 把「名单外 @ agent」格设成 explicit = **该范围内任何人 @ 它都能开工单**——适合专用支持入口，**慎用**。
   - admission 表属于 Policy version：把格子调弱**不会立即停掉**凭它接的工单，但在工单恢复前重校验时可能撤销其 Mandate（docs/002 Admission）。
5. **bot 列表**：被识别的 bot（GitHub App、`[bot]` 结尾 login、飞书 bot）里，只有列进名单的（如 `dependabot[bot]`）其消息可成为**推断候选**，且必须 @ agent 或发在收全部消息的范围；bot **永远不能**发明确请求、不能停工单。用普通账号跑的自动评审工具会被当成人——要在团队提示词里写明「这个账号是自动评审器」（docs/002 Bots and automated reviewers）。

### 4.2 推荐的安全起步配置（既安全又不饿死）

对照 docs/000「Start narrow」与 SETUP 的默认值：

1. 允许名单只放你自己；accept mode = `observe`；GitHub 的 receive-all 开关**保持关闭**（默认只收 @ 到 agent 的通知）。
2. 观察一到两周 Eval 页里「would accept」的记录：它本来想接的活，是不是你也会让它接？
3. 判断靠谱后：逐步加名单成员 → 打开需要的 receive-all 范围 → 写好规则 → 切 `auto`。
4. 「饿死」自查清单（@了没反应时按序查）：发送者在不在名单 → Source 开没开 → 是不是 paused → 是不是编辑旧正文加的 @（收不到，要发新评论）→ Source 页看 Trigger 是不是被过滤（docs/006 Troubleshooting 末行）。

### 4.3 Mandate 的重新校验（resume 前的关卡）

出处：docs/002 Revalidation before resume

已结束工单被人的消息唤醒前会重校验：Source 必须还在监听原 Thread；明确跟进的 Mandate 直接过；推断类 Mandate 需要当前是 `auto` 且命中规则仍启用；admission 格进来的 Mandate 需要在今天的表和名单下仍有不低于当初的强度（所以**把人移出名单可以撤销凭「名单内发送者」格接的工单**）；bot 的 Mandate 要求该 bot 仍在名单。校验失败：工单保持结束，等待中的消息当作「没到达任何工单」重新走 Eval。只有三个操作改变 Mandate：**accept 创建、人 stop 撤回、重校验失败撤销**。

---

## 5. 提示词与团队段：哪些能在面板改、改了影响什么

出处：docs/004（主）、docs/005 Settings groups

### 5.1 能在面板改的（Settings → Prompts → Edit）

- **三个团队段**：
  | 段 | 装什么 |
  | --- | --- |
  | Communication | 什么时候给人发消息、消息口吻、每条 GitHub 消息开头的披露行（默认 `This is by an automated agent, not a human`）、怎么处理评审、哪些普通账号是 review bot |
  | Ticket scope | 工单什么时候继续、什么时候带着草稿停下 |
  | Delivery requirements | PR 里的证据要求、auto-merge 条件（含行数阈值，默认 200 行）与提交作者；不写提交作者则以 agent 账号的 no-reply 地址提交 |
- **团队 skills**：agent 按需加载的知识，例如一个 `identities` skill 说明哪个飞书用户对应哪个 GitHub 账号。
- **每个内置系统提示部件的 override**：keys 包括 `runtime/shared`、`runtime/orchestrator`、`runtime/worker`、`runtime/subscriptions`、`runtime/replies`、`runtime/dispatch`、`runtime/work`、`runtime/admission`、`runtime/handoff/*`、`skill/feishu`、`skill/github`，以及生成段模板 `runtime/environment`（占位符 `{variables}`）、`runtime/policy`（`{version}`/`{mode}`/`{rules}`）、`runtime/policy/none`。模板占位符必须保留。

### 5.2 改了影响什么

- 提示词改动**只改变模型收到的指令**。**gate、Mandate、工具检查、账号 wrapper 都由代码强制执行，提示词改不动**（优先级第 1 层）。完整优先级（从强到弱）：① 工具与主机强制的事实 → ② 内置与生成段（含你的 override）→ ③ 主动工单命中规则的流程/沟通要求（仅该工单）→ ④ 团队段与团队 skills → ⑤ 外部文本（消息/评论/文档/引用，永远只是数据）。
- **生效时机**：Session 在**每次模型请求**时读最新版本（包括同一轮的后续步骤）；保存不会重启、取消或唤醒任何 Session。
- **版本管理**：每次保存产生一个不可变版本；带基线 revision，冲突保存被拒（草稿不丢）；可恢复历史版本或默认值。与默认相同的 override 会被自动移除，以便跟随未来默认。
- **升级后的 `Default updated` 标记**：上游改了某个你 override 过的部件的默认文本时，面板标注并展示新旧默认对比，你选「保留我的文本」或「采用新默认」；没有 override 的部件自动跟随新默认（docs/004、docs/005）。
- 主 Session 也可在**人明确要求时**用 `orchestrator_prompts_save` 保存 override（docs/004）。

### 5.3 不能改的

工具描述、通知文案和卡片措辞在代码里，**不能**通过提示词设置修改（docs/004）。Executor 不读会话外的指令：它读 DSH 的编码提示词和**仓库的 AGENTS.md**；主 Session 不读 AGENTS.md（docs/004）。Executor 的工具里**没有** ask_user_question、present、plugin_manager 这类「问人/展示/改 profile」的工具（docs/004、docs/007 Executor tools）。

---

## 6. 健康与排障

出处：docs/006（主）、docs/002「When Eval does not finish」

### 6.1 状态脚本与退出码

```sh
scripts/dsh-superagent start|stop|restart|status   # 另：--profile、--url，或环境变量 DSH_SUPERAGENT_PROFILE / DSH_SUPERAGENT_URL
```

| 退出码 | 含义 | 动作 |
| --- | --- | --- |
| 0 | 服务正常（仍在启动中的 Source、setup 没验过的飞书 bot 都算正常） | 无 |
| 1 | 没在跑 / 跑了两个 / 不应答 / runtime 报错 | 重启可能有效；看输出与最新日志 |
| 2 | 在跑，但 runtime 之外的部件（Source、名单同步 `sync:<source id>` 等）报错 | **重启修不好**；`errors` 列出每个部件及细节，部件恢复后自行清除 |
| 3 | 在跑，等 setup | **重启修不好**；`setup` 说明缺什么，Overview 有链接 |

`stop`/`restart` 优雅停机，等 Executor 最多 5 分钟，**绝不强杀**；`start` 拒绝重复实例。只有 `stop` 会写停止标记（`--respect-stop` 的 restart 会尊重它）。

### 6.2 健康条目（GET state 的 health，面板 Overview 系统问题同源）

| 条目 | 报告什么 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 有 Session 在等模型额度重试 |
| `evals` | 最近 1 小时无后续判定也未被 dismiss 的 unavailable Eval |
| `assessment` / `launch` / `delivery` / `relay` / `notice` / `reply` | 各类「先落库后执行」的 stored work；delivery 的失败显示在工单上，reply 覆盖 Channel 消息 |
| `worker` | Executor Session 事件处理（首次失败后出现） |
| `github` / `feishu` / `history` | Source 轮询、事件与历史恢复 |
| `sync:<source id>` | 允许名单同步 |

通用规则：一类工作**连续失败 3 次**才在 Overview 报系统问题（一次性网络抖动不算问题，docs/003、docs/005「Quiet by default」）。

### 6.3 状态目录与日志

- `stateDir`（cordis.patch.yml 里配置）：`orchestrator.sqlite`（数据库，**升级前备份**）、锁、`worker-bin/`（命令 shim：`gh`→agent CLI、`lark-cli`→bot CLI、blocked commands 直接失败）、`worker-gitconfig`（agent 的 git 配置）、`work/`（默认工单目录）。
- 日志：profile 的 `.artifacts/` 下，`dsh-superagent-<profile>-<日期>-<时间>-<pid>.log`（保留最新 20 份）；控制文件在 `control/profiles/<profile>/`（停止标记、锁、pid）。
- 排障三板斧：`status` 退出码 → Overview 系统问题/setup 缺项 → 最新日志。

### 6.4 常见 Setup 错误速查

出处：docs/006 Troubleshooting（完整表以原文为准）

| 症状 | 原因与处理 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片设置 agent CLI |
| `The agent GitHub CLI was not found.` | 用 wrapper 绝对路径，或 PATH 上的命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 登录该 wrapper |
| `@… cannot read …` / `cannot push to …` | 给 agent 账号仓库写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片填 `owner/name` |
| 工单失败 `The prepare command failed: …` | 输出里有原因（如 clone 路径错）；改命令后 Retry 工单 |
| `git does not read the github.com credential configuration…` | git 需 ≥ 2.32 |
| 工单失败 `The git configuration of the repository in … sets …` | 删掉该 clone `.git/config` 里被指名的 credential / `http.*.extraheader` |
| `… was not written by dsh-superagent` | `worker-bin`/`worker-gitconfig` 里有外来文件：移走或换 stateDir |
| `The bot lark-cli allows user identities` | 飞书 Source 要指向「仅 bot」的 lark-cli 配置（docs/006 Accounts） |
| `The Feishu bot is not a member of the chat.` | 把 bot 拉进群 |
| `… timed out after 90 s` 等 CLI 无输出失败 | 以运维者身份手动跑该程序看它自己的报错 |
| 面板提示 dsh-superagent 不应答 | 在重启中，或因配置没起来；DSH 日志有原因 |
| 升级 DSH 后面板 `Failed to load plugins` | 重启运行中的实例 |
| **@了没反应** | 查：作者在名单？Source 开着？没 paused？GitHub 上编辑旧正文加的 @ 收不到——发新评论 |

### 6.5 Management API（脚本化运维可选）

面板走本地 HTTP API，agent 也可调用：`http://127.0.0.1:<port>/orchestrator/api/`，必须带头 `x-orchestrator-request: 1`，Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（否则 403）。常用：`GET state`、`GET settings`、`PUT settings/<block>`（带 revision，409 = 版本过期；返回 `restarting: true` 表示保存触发重启，等 status 不再退出 1 再继续）、`POST executor/pause`、`POST setup/check`、`POST tickets/<id>/retry|stop`、`GET/PUT prompts`（docs/006 Management API 有完整表和 curl 示例）。

### 6.6 升级与回滚

出处：docs/006 Upgrade

1. 等没有 Executor 在 turn 中间；2. 备份 `<stateDir>/orchestrator.sqlite`；3. `git pull && pnpm install && pnpm build`；4. `scripts/dsh-superagent restart` 并看 status。

**回滚只能靠升级前的备份**——新版本迁移过的数据库老版本打不开。升级后检查 Prompts 里的 **Default updated** 标记。升级 DSH 本体后要重启运行中的实例。**不要**重跑 profile 创建命令（会清掉 cordis.patch.yml）。

---

## 7. 边界与红线

出处：docs/000、docs/001、docs/002、docs/003、docs/006

**它不会做的事（架构级保证，提示词改不动）**：

- 不会响应「未获授权」的请求：主机强制执行名单、规则和 Mandate；**消息、评论、引用文档都只是决策的输入，永远不能改变权限**（docs/002 开头）。墙外的人写得再像命令也没用。
- 不会未经 Eval 创建工单；不会自己撤销 Mandate；Executor **不能**宣布「有人让我停」——停止一律由 Eval（Thread 里的 stop 消息）或人（面板 Stop）决定（docs/001 Rejected concepts、docs/002）。
- 默认**不会给自己开 auto-merge**：GitHub 把合并记在开启者头上，所以默认由人来合并；要开也必须在 Delivery requirements 里指定**另一个账号**的 CLI，且默认指令还有门槛（PR 就绪、审批覆盖 head commit、增删行 < 200）（docs/003 Merging）。这些是指令层面的约束；要硬约束就用分支保护。
- 不会等：主 Session 设计上不被允许 sleep/长等待（守卫拒绝 sleep、>30s 的 shell 超时、>5s 的 job 等待），阻塞的步骤会延误新候选（docs/004、docs/007）。
- 不映射跨 Source 身份：「这个飞书用户就是那个 GitHub 账号」只能靠团队 skill/prompt 文字告诉它（docs/001）。

**安全边界（务必读）**（出处：docs/006 Permissions and isolation）：

- 两个 preset（`dsh-superagent-worker`、`dsh-superagent-router`）都以**运维者的 OS 用户**跑 `danger-full-access`：worker 能用绝对路径执行任何程序、能读运维者的 home 目录。CLI wrapper 和工单目录**是默认值，不是安全边界**。要真隔离：**用只含 agent 凭证的专用 OS 账号**跑这个服务。
- 这两个 preset 出现在 DSH preset 列表里但**专供 dsh-superagent**：不要给个人 Session 选它们，也不要删它们的配置行（否则 Session 恢复报 `agent-preset/not-found`）。

**什么时候该人工介入**：

- 面板出现 `person/*` 阶段的工单（Awaiting answer / Awaiting review / Blocked / Failed / Input undelivered 持续不消）。
- `evals` 健康条目报错（unavailable Decision）：24 小时内、仍是 Thread 上最新决定、未 dismiss 的，面板会请你**重新评估或 dismiss**（docs/002）。
- `status` 退出 2 或 3：分别看 `errors` 与 `setup`。
- 觉得它「吵」：先改提示词（更短更严）或 Pause processing；**不要**让它发更多消息解释自己（docs/000）。
- 它以你们的账号说错了话：你负责。读完它发的东西，在提示词里纠正（docs/000 Own what it says）。

---

## 8. 本 fork 的 GitLab 源（上游文档未覆盖使用细节）

> ⚠️ **出处声明**：上游文档只在 docs/007 架构模块表中列出 `src/sources/gitlab*.ts`（`./gitlab-watch` 插件：todo 与已打开 issue/MR 轮询、订阅 Thread、只当门铃的 webhook），**没有**像 GitHub/Feishu 那样的使用文档。本节事实取自本 fork 源码：`src/sources/gitlab.ts`（kind 定义、配置字段、Policy、执行环境变量）、`src/deployment.ts`（setup 检查）、`cordis.patch.yml`（插件注册，默认 disabled）、`skills/dsh-superagent-gitlab/SKILL.md`（worker 操作约定）。以源码为准，上游文档的其他概念（Trigger/Thread/Eval/Policy/Mandate 等）原样适用。

### 8.1 启用

1. `cordis.patch.yml` 中 `dsh-superagent-gitlab`（name: `dsh-superagent/gitlab-watch`）默认 `disabled: true`，改为 `false` 启用。
2. 给 agent 一个 **glab wrapper**：用 `GLAB_CONFIG_DIR` 隔离配置、登录 agent 的 GitLab 账号（与 gh-agent/lark-bot 同一模式）。
3. 面板 GitLab 卡片填三项：**实例地址**（如 `https://gitlab.example.com`，不带尾斜杠）、**监听的项目**（`group/name` 或 `group/sub/name`；保存时会**检查 agent 账号能推送（Developer/level 30 及以上）**，然后自动重启）、**agent 的 GitLab CLI**（命令名或绝对路径）。
4. 可选开关（默认全关）：接收项目里的新 issue / 新 MR / 评论——对应 admission 表的 `issues`/`mrs`/`notes` 三行。
5. 高级项：`pollSeconds`（默认 60）、`failuresBeforeError`（默认 3）、`webhookToken`——非空时接受 `POST /superagent/gitlab-webhook`（校验 `X-Gitlab-Token` 头），**webhook 只当门铃唤醒一次轮询，数据仍从 API 拉取**；留空则不注册该路由，纯轮询也能正常工作。
6. 认证替代关系（源码 `resolveForges`）：GitHub 与 GitLab **至少配通一个**即可，可只配 GitLab。

### 8.2 授权

- GitLab Source 的 Policy 只有**允许名单**（`allowed`，GitLab 用户名）：名单内账号在 issue、MR 或评论里 **@ agent 账号** = 明确请求（源码 `policy.explicit`）。
- admission 表行 = `issues` / `mrs` / `notes`，语义与 docs/002 的表一致。

### 8.3 它收什么、怎么交付

- **接收**：发给 agent 的 **todos** 与提及、已订阅 issue/MR 的讨论。Thread key 形如 `gitlab:issue-<iid>` / `gitlab:mr-<iid>`。
- **交付**：一律以 **MR** 交付——分支名 = 工单短名（`$DSH_SUPERAGENT_NAME`），用 git 推送（凭证已预配置），用 `glab api` 开 MR（`remove_source_branch=true`）。**永不推默认分支、永不直接合并**，auto-merge 只看 Delivery requirements 怎么写。
- **worker 可见的环境变量**：`DSH_SUPERAGENT_GITLAB_HOST`、`DSH_SUPERAGENT_GITLAB_PROJECT`、`DSH_SUPERAGENT_GITLAB_ACCOUNT`、`DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL`、`DSH_SUPERAGENT_GITLAB_IID`（非 GitLab 来源的工单为空）。除合并外的 GitLab 操作一律用 glab（agent 账号），不得用其他账号或凭证。
- 评审讨论在 MR 的 discussion 里回复，按 Communication 段决定是否 resolve；开/认领 MR 后立即 `orchestrator_report`（progress + pr_number），不等流水线。
- 提交作者：Delivery requirements 指定者，否则 agent 账号 + 其提交邮箱。

---

## 附录 A：术语速查

出处：docs/001 Glossary（完整双语表见原文；面板 (?) 按钮也能打开）

| 术语 | 中文 | 一句话 |
| --- | --- | --- |
| Source | 来源 | 一条事件流：插件提供的 kind + 一份实例配置 |
| Trigger | 触发 | 来自 Source 的一条不可变事件 |
| Thread | 线程 | 按时间排序的 Trigger；Eval 在其上串行 |
| Channel | 渠道 | Thread 的写侧（回话地址） |
| Policy | 策略 | 版本化的接活规则 + 各 Source 的名单/admission 表 |
| Eval | 评估 | 一批 Trigger → 一个 Decision；两层：gate 准入 + assessment 研判 |
| Decision | 决定 | accept 接单 / stop 停止 / ignore 忽略 / unavailable 未完成 |
| Mandate | 授权 | accept 授予什么：强度、范围、Policy 版本、命中规则 |
| Ticket | 工单 | 一个被授权的工作单元 |
| Assignment | 派工 | 工单到某个 Executor 实例的绑定 |
| Subscription | 订阅 | 工单 ↔ Thread 的多对多关系，让后续讨论直达 Executor |
| Executor | 执行器 | 每工单一个 Session + 一个目录 |
| Report | 报告 | progress / waiting / ready / blocked / failed / dropped |
| Attention | 待人工决定 | 工单上等回答的问题 |
| Strength | 强度 | explicit 明确 / inferred 推断 |

## 附录 B：运维命令速查

```sh
scripts/dsh-superagent start      # 启动（tmux 会话 dsh-superagent，拒绝重复实例）
scripts/dsh-superagent status     # 退出码 0/1/2/3，见 6.1
scripts/dsh-superagent stop       # 优雅停机（写停止标记，等 Executor 最多 5 分钟）
scripts/dsh-superagent restart    # 优雅重启（不写停止标记）
# 非默认 profile/端口：--profile / --url，或 DSH_SUPERAGENT_PROFILE / DSH_SUPERAGENT_URL
# 开发自检（本仓库）：pnpm check（类型检查 + 测试 + 构建）
```

面板入口：DSH Web 侧边栏 **Superagent**（默认 `http://127.0.0.1:3082`）。
