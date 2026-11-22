# Upstream issue draft — SUPERSEDED, do not post as-is

> 2026-11-22 更正：本稿的中心论断（「同目标只留一条 pending todo，重复 @ 不产生新 todo」）被我们自己的后续证据推翻。**不要按此稿发上游 issue。**

## 当时观测

- 12:12 机器人自 @ 产生 todo 795；12:24/12:29 两条真人 @ 评论后，04:27–04:33 多次列 pending 队列只见 795 → 当时判定「重复 @ 不产生新 todo」。

## 后来的反证

- todos 游标走到 797：todo 796（对应 12:24 评论）与 797（对应 14:39 评论）**确实被创建并被接单**——mention→todo 是 Sidekiq 异步的，当天上午有几分钟延迟，观测窗口太短导致误判。
- 修复后的实测：notes 监听先收（触发器落库比 todo 触发早 185ms），todo 796/797 随后也到了——双通道都通。
- 「一人一目标一条 todo」未获证实；795/796 之后从 pending 消失的原因也未查明（本机 mark_done 全系 404，非我们清的）。

## 仍然成立、值得上报的点

1. **GitLab 17.6.5 实例上 /todos 写端点全系 404**（GET 列表正常，POST /todos/:id/mark_done 与 POST /todos/mark_done 均 404；todos 在列表里可见）。是实例反代还是版本行为，需要有人在别的 17.6 实例上复核。
2. mention→todo 的异步延迟在 Sidekiq 繁忙时可达分钟级——对「发完评论盯着等接单」的用户体验是真实的坑，source 侧加 notes 监听（我们已在 fork 实现，commit 31eaaab）能把可见延迟压回一个轮询周期。
