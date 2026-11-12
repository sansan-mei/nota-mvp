# AGENTS.md

本仓库是 Nota AI 语音便签的笔试 MVP。AI 编程工具改代码前先读这份文件。

## 约束

- **不加运行时依赖**。只用 Node 内置模块（`node:http`、`node:sqlite`、`fetch`）。devDependencies 只放类型检查工具。
- **TypeScript 只用可擦除语法**：Node 直接运行 `.ts`，不经过编译。不能用 `enum`、`namespace`、参数属性；导入要写 `.ts` 后缀；纯类型导入用 `import type`。
- **不提交密钥**。`.env` 已加入 `.gitignore`，新增配置项要同步到 `.env.example`（只写变量名和默认值）。
- 回复用户、注释、文档用中文。

## 改动后必须跑的命令

| 改了什么 | 必须跑 |
|---|---|
| 任何代码 | `npm run typecheck`、`npm test` |
| `src/quota.ts`、`src/db.ts`、`src/app.ts` 中额度或请求相关的逻辑 | 再跑 `npm run proof:quota`，四项必须全部 ✅ |
| `src/agent.ts` 的提示词、`src/tools.ts`、更换模型 | `npm run eval -- --runs 2`（需要真实 key），通过率不能低于 README 里记录的上一版；结果更新到 README 的评估表 |

## 不能破坏的不变量

- 扣次只能用 `BEGIN IMMEDIATE` 事务内的条件 UPDATE（`used < limit`），不能改成「先查剩余再扣」。
- `(user_id, request_id)` 是幂等键：已完成的请求返回原结果，处理中的返回 409，都不扣次。
- 额度只在 `processing → failed` 这次状态迁移时返还，保证只返还一次。
- Agent 产生的待办、日程、提醒先写进草稿，和 `requests.status = 'done'` 在同一个事务里提交。不要在工具执行时直接写库。
- 时间由代码解析和校验（`src/time.ts`），模型只传用户本地时间字符串。
- 对账必须成立：`daily_usage.used` = 流水 `SUM(delta)` = 已扣次请求数。

## 审查 AI 生成的代码

- 涉及额度、事务、并发的改动逐行审，并补一个能复现问题的测试（先红后绿）。
- 不要为了让测试通过而改断言或删测试，先确认是代码的问题还是测试的问题。
- README 里的数字（测试数、压测输出、评估通过率）必须来自实际运行结果，不能估算。
