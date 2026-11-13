# Grammar Loop

英语语法诊断初版：上传与核对 → 逐题诊断 → 修改标签 → 专项练习 → 更新复习计划。

仓库保留开发、运行和测试所需文件，以及 30 题文本、来源清单和一张真实联调题页。手册、展示截图、历史报告和渲染产物属于本地交付资料，不随源码仓库提交。Windows 启动说明见 [运行环境](docs/runtime.md)。

## 本地启动

要求 Node.js 22.13+，已验证 Node.js 24。Windows 可以双击项目根目录的 `start.cmd`；它会定位已有 Node.js，并同时启动网页与 Worker。克隆后，在项目根目录打开 PowerShell，首次运行：

```powershell
.\scripts\run.ps1 install
.\scripts\run.ps1 dev
```

出现 `Node.js was not found on PATH` 时，更新后的脚本会自动查询已安装的 Codex runtime，无需手工修改 PATH。使用 `.\scripts\run.ps1 doctor` 可检查定位结果。若 PowerShell 限制脚本执行，运行 `.\start.cmd`，该入口只为本次进程设置执行策略。详情见 [Windows 环境说明](docs/runtime.md)。

普通开发环境：

```sh
pnpm install
test -f .env.local || cp .env.example .env.local
pnpm dev
```

已有 `.env.local` 时保留其中配置，不要用模板覆盖。

当前 Git 规则允许项目根目录的 `.env.local` 随代码提交。其中的真实服务凭据会进入仓库历史，仓库访问者可以读取；其他环境文件仍默认忽略。

访问 <http://127.0.0.1:3000>。`dev` 同时启动 Next.js 和常驻 Worker；离开页面不会中断后台任务。生产运行需分别启动 `pnpm start` 与 `pnpm worker`。

未配置外部服务时，默认使用本地私有会话和 `.data/` 文件存储。点击“先体验真实题样例”，可以完成确认、诊断回放、改标、演示练习、提交和复习更新。页面明确标识样例回放；这些结果没有调用 DeepSeek。演示练习不属于高考真题。

本地浏览器 Cookie 是本地学习记录的身份；清除 Cookie 会创建新身份。`.data/` 包含私有学习数据、图片及会话密钥，应保留且不要上传版本库。

## 连接 DeepSeek

在 `.env.local` 填入：

```dotenv
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=deepseek-flash
```

重启 `dev`。随后可以上传 JPG/PNG，实际请求 `https://api.deepseek.com/chat/completions` 完成图像识别、诊断讲解和练习生成。密钥只在服务端使用。没有密钥时真实上传会明确提示配置缺失，不回退成假 AI 输出。

未知题由模型给出暂定参考答案，界面保留 AI 来源；已匹配的样例按已记录公开参考答案判分。暂不设置模型准确率验收指标。真实 API 的可用性、模型名称和额度需在配置后联调验证。

## 连接 Supabase

1. 创建 Supabase 项目，将 `.env.example` 中的 URL、anon key、service_role key 和数据库 direct/session 连接串填入 `.env.local`。
2. 执行 `pnpm db:migrate`，或 Windows ` .\scripts\run.ps1 db:migrate`。
3. 设置 `STORAGE_MODE=supabase` 并重启 Web 与 Worker。
4. 在 `/login` 使用邮箱注册/登录。若项目开启邮箱确认，先确认邮件。

`NEXT_PUBLIC_SUPABASE_*` 用于浏览器登录。其余凭据均仅供服务端使用。修改公开环境变量后，生产构建需要重新执行。

迁移创建私有 bucket 和 server-only 的 `gl_workspaces` 表。业务状态在一个用户聚合中保存，通过 revision 乐观并发控制原子更新。前端不能直接查询此表，以免绕过 API 读取未提交练习的答案；BFF 先核验 Supabase 身份，再访问该用户数据。

配置 `DATABASE_URL` 后启用 pg-boss。任务先持久化，Worker 同时定期恢复未投递或失去心跳的任务；没有数据库连接串的本地模式使用持久化轮询。长时间模型请求在数据库事务之外执行。

## 30 道真题材料

`data/samples.json` 收录 2025 全国一卷开发 10 题、2023/2024 新课标Ⅰ卷功能测试 20 题，保留完整语篇、提示词、来源、模拟作答和讲解。原题答案属于公开资料交叉核对，状态为 `cross_checked`；没有冒称官方逐题核验或教师审核。详细出处、历史核对记录及仓库材料范围见 [语料说明](data/README.md)。

校验脚本检查 30 题数量和篇章关系，不代表模型普遍准确率。核心测试会模拟外部模型响应，以验证真实上传 API 的请求与处理链路；这些测试不产生真实模型费用。

## 验证与运行

```sh
pnpm typecheck
pnpm test
pnpm build
```

Windows 可以使用 `scripts/run.ps1` 加同名任务。`pnpm build` 后运行 `pnpm start`，并在另一个进程运行 `pnpm worker`。

`typecheck` 会先运行 `next typegen` 生成 Next.js 类型，再运行 TypeScript 检查。自动生成的 `next-env.d.ts` 和 `.next/` 不纳入版本控制。测试生成的 `docs/report/` 等报告同样只保存在本机。

真实服务联调可以运行：

```sh
pnpm exec tsx scripts/check-supabase.ts
pnpm exec tsx scripts/live-smoke.ts --supabase
```

这两个脚本自行读取 `.env.local`。前者只读检查配置与数据库；后者使用仓库中的 `data/sources/2025-question-page11.png`，真实调用 DeepSeek，并使用独立队列和临时测试账号，验证登录、私有图片、诊断、改标、练习及复习更新，结束时清理该测试账号和测试图片，不发送注册邮件。真实调用会使用模型额度。输出仅包含脱敏状态，运行后在本地生成 `docs/live-test-supabase.json` 等报告，不随仓库提交。脚本中的存储模式覆盖仅作用于测试进程，不修改 `.env.local`。

Docker 运行：先创建 `.env.local`，再执行：

```sh
docker compose --env-file .env.local up --build
```

Web 端口仅绑定本机 3000。部署到其他环境时配置 HTTPS、确切的 `APP_ORIGIN` 和对应的 Supabase 公开环境变量。Docker/Supabase 实际环境需由拥有凭据的部署方验证。

## 已保留的扩展边界

- `FileNormalizer`：后续接入 PDF、HEIC、多页。
- `GrammarAI`：后续接入解题复核或模型替换。
- `ReviewScheduler`：后续替换固定 1/3/7 天调度。
- 来源、审核状态、规则引用、题型与版本字段：便于未来内容审核和扩展。

初版没有实现教师工作台、知识地图、复杂掌握度或多模型质量系统。
