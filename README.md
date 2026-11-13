# Nota MVP · AI 语音便签

说一段话（或输入一段文字），AI Agent 自己决定调用哪些工具：整理摘要、建待办、建日程、设提醒，或者翻历史便签回答问题。Free 用户每天 10 次，并发、重试、重复提交下都能保证准确，有测试证明。

- 后端：Node.js（≥ 22.18，推荐 24 LTS，开发环境 26），**零运行时依赖**：`node:http` + `node:sqlite`，直接运行 TypeScript
- 模型：通义千问 `qwen3.6-flash`（OpenAI 兼容接口 + function calling），可换 Kimi / GLM / DeepSeek
- 语音：网页按住录音（模拟硬件按键），上传后由千问 `qwen3-asr-flash` 云端转写，与大模型共用一个 key
- 网页：React + Vite + Tailwind + shadcn/ui，动效用 [animate-ui](https://animate-ui.com)；Agent 每一步实时显示（NDJSON 流）

## 运行

```bash
cp .env.example .env        # 填入 LLM_API_KEY（阿里云百炼 DashScope）
npm run setup               # 安装依赖并构建网页（web/dist）
npm run seed:demo           # 可选：写入几条“过去的便签”，用来演示历史问答
npm start                   # http://localhost:3000
```

开发前端时另开一个终端运行 `npm run dev:web`（http://localhost:5173，接口代理到 3000 端口）。

没有 key 时可以设置 `LLM_MOCK=1`，用离线假模型体验界面和跑测试。

页面右上角可以切换演示用户：小明、小红（Free，每天 10 次），老王（Pro，不限次数）。页面右侧的「额度对账」卡片会实时显示三方对账结果。点「同时发 15 个请求」可以当场演示并发：实测在已用 2 次时，成功 8 个、被拒 7 个，刚好用满 10 次。

## 架构与关键取舍

单个 Node 服务：接口 + SQLite，同时提供构建好的网页。

- **Agent**：千问 function calling，5 个工具，最多 6 轮。时间由代码换算校验，模型只填本地时间；参数错误时把原因回传给模型，让它自己修正。
- **副作用先进草稿**，成功后与请求状态在同一事务提交，失败不留半截数据。
- **额度**：客户端 requestId 作幂等键；`BEGIN IMMEDIATE` 内用条件 UPDATE（`used < 10`）扣次；失败只在状态迁移时返还一次；按用户时区切天；流水表可对账。
- **取舍**：同步处理 + 流式返回，不上队列；SQLite 代替 PG/Redis，用多进程测试证明正确性；历史检索用关键词，不用向量。

详细说明（网页 / App / 硬件三者关系、时序图、生产化改造）见 [docs/architecture.md](docs/architecture.md)。

## 额度准确性：怎么证明

```bash
npm test               # 14 个测试：单元 + 多进程 HTTP 集成
npm run proof:quota    # 打印压测报告
```

`proof:quota` 会起 **3 个服务进程共用一个数据库**（模拟多实例部署），假模型每次处理 200ms，用来拉大并发窗口。实测输出：

```
1. 并发：40 个不同请求同时发出 → 成功 10，429 拒绝 30，其他 0  ✅
   对账：used=10 流水合计=10 扣次请求=10 便签=10  ✅
2. 重复提交：同一 requestId 发 15 次 → 实际处理 1，返回原结果 5，处理中 409 9  ✅
   对账：used=1 便签=1  ✅
3. 模型故障：返还=true，used 1 → 1  ✅
4. 客户端断线后重发：首次中断=true，重发拿到原结果=true，额度变化 +1  ✅
   最终对账一致：✅
```

测试本身也验证过：把扣次改成「先查后扣」后，4 个测试报红。

单元测试还覆盖以下情况：北京时间 23:59:59 和次日 00:00 算两天；失败返还只发生一次；失败后用同一个 requestId 重试会重新扣次；进程崩溃后卡在「处理中」的请求，启动时自动返还；Pro 用户不计次。

## Agent 效果评估

```bash
npm run eval -- --runs 2
```

[eval/cases.json](eval/cases.json) 里有 8 条用例：日程加提醒、截止日期、一句话多件事、纯记录（不该建待办）、明确时间、历史问答、查不到时不能编数字、口语。用例固定「当前时间」和历史数据，按规则判分，明细保存在 `eval/results/`，方便对比改 prompt 或换模型前后的效果。

| 版本 | 通过率 | 发现的问题 |
|---|---|---|
| prompt v1 | 14/16（87.5%） | 「后天晚上看电影」两次都没建日程（一次反问，一次只建了提醒）。「上个月」被理解成最近 30 天（这条用例当时没判出来，看明细才发现） |
| prompt v2：明确自然月；有日期的安排直接建日程（这一版起，历史问答用例改为两次报价都必须答出） | 15/16（93.8%） | 提问时偶尔多存一条摘要 |
| prompt v3：回复改为纯文本，不用 Markdown | 16/16，再跑一轮 24/24 | 用例只有 8 条，覆盖面有限；接下来要从真实录音里抽样扩充 |

## 目录

```
src/
  server.ts   启动、超时请求清理
  app.ts      路由、NDJSON 流
  agent.ts    Agent 循环、系统提示词、结果提交
  tools.ts    5 个工具（参数校验、草稿、历史检索）
  quota.ts    预占 / 返还 / 清理 / 对账
  llm.ts      OpenAI 兼容客户端 + 离线假模型
  asr.ts      千问语音识别、转写限流
  time.ts     时区、自然日、日期对照
web/          网页（React + shadcn/ui + animate-ui），构建产物 web/dist 由后端提供
test/         单元测试 + 多进程并发集成测试
scripts/      quota-proof.ts、seed-demo.ts
eval/         评估用例与评估脚本
docs/         架构、时序图
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/transcribe` | 请求体为录音（webm/mp4/wav 等，≤3MB），返回 `{text}`。不占 AI 处理额度，每个用户每分钟最多 20 次 |
| POST | `/api/notes` | `{requestId, text}`，返回 NDJSON 流（accepted → step… → done/error）；429 额度用尽，409 处理中，422 同一个 requestId 内容不同 |
| GET | `/api/me` | 用户与今日额度 |
| GET | `/api/quota/audit` | 当日对账：used、流水合计、扣次请求数、便签数 |
| GET | `/api/notes`、`/api/notes/:id/steps` | 历史便签、某条便签的 Agent 步骤 |
| GET/PATCH/DELETE | `/api/items`、`/api/todos/:id`、`/api/{todos,reminders,events}/:id` | 列表、完成、撤销 |

身份用请求头 `x-user-id` 演示，正式产品换成登录态，额度逻辑不变。

## 没做的部分与限制

- 转写是「录完再识别」，不是边说边出字；单段录音最长 60 秒。
- 日程和提醒只保存在本地数据库，没有接入真实日历或推送。
- 有副作用的操作是「直接执行 + 可撤销」，没有做「先确认后执行」，设计见 Part A T3。
- 生产环境要换 PostgreSQL 并加任务队列，见 docs。
- `seed:demo` 写入的历史日期是相对当前时间计算的，月初运行时「上个月」可能只覆盖部分演示数据。
