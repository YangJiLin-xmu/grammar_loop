# Windows 本地运行环境

项目需要 Node.js 22.13 或更新版本，已验证 Node.js 24。最低版本同时考虑了 pg-boss 和项目 pnpm 11 的要求。常规环境可使用 npm；这台 Windows 上也可以复用已安装的 Codex Node.js 和 pnpm，无需安装系统级工具。

## 直接启动

双击项目根目录的 `start.cmd`。它会切换到项目目录、按需安装缺失的依赖并同时启动网页与 Worker。保持终端开启，看到 `Ready` 和 `Grammar Loop worker ready` 后，打开 <http://127.0.0.1:3000>。按 `Ctrl+C` 停止。

在项目目录的 PowerShell 中运行：

```powershell
.\scripts\run.ps1 install
.\scripts\run.ps1 dev
```

脚本也支持 `doctor`、`typecheck`、`test`、`build`、`start`、`worker` 和 `db:migrate`。`start` 指生产网页服务，需先 `build` 并另行运行 `worker`；首次体验使用默认 `dev` 即可。

脚本依次检查指定的 `GRAMMAR_LOOP_NODE`、项目 `.tools/node/node.exe`、PATH、Node 常见安装位置及已注册的 Codex runtime，验证版本后将其目录加入当前进程 PATH。WindowsApps 可能禁止通配符枚举，因此也通过 `Get-AppxPackage` 查询准确安装路径。子进程继承这一配置。包管理优先使用项目或同一 runtime 的 pnpm CLI，绕开损坏的命令 shim；否则使用 npm。

这些操作不会修改系统或用户的持久 PATH，也不会改写 `.env.local`。`.tools` 是本机运行辅助目录，不纳入版本控制。其他电脑若没有任何兼容 Node，需要先安装 Node.js 24，或设置 `GRAMMAR_LOOP_NODE` 指向已有 `node.exe`。

## 普通 PowerShell 找不到 Node

已复现的故障是在 Anaconda `(base)` 终端执行 `scripts/run.ps1 dev` 时提示 `Node.js was not found on PATH`。原脚本仅会定位 pnpm，却仍要求 Node 出现在 PATH；普通终端没有 Codex 添加的临时路径。新版脚本会自主发现并验证运行时。

可以先执行以下诊断命令，它只输出工具路径、版本和文件是否存在，不展示任何密钥：

```powershell
.\scripts\run.ps1 doctor
```

若遇到执行策略拦截，可通过 CMD 入口执行同一诊断：

```powershell
.\start.cmd doctor
```

`start.cmd` 使用系统 Windows PowerShell，并仅对它启动的进程设置 `ExecutionPolicy Bypass`，不需要以管理员身份运行，也不修改系统策略。

同一工程只运行一份开发服务。如果提示 `Another next dev server is already running`，直接打开终端给出的地址；需要重启时，先在原启动窗口按 `Ctrl+C`，再执行启动命令。不要因为重复启动提示而删除学习数据。

`pnpm-workspace.yaml` 仅允许 `esbuild` 和 `sharp` 运行依赖安装脚本，供 pnpm 11 的安装策略使用。

## 当前宿主环境修复

本次发现，Codex 启动的部分命令进程没有 `SystemRoot`、`WINDIR` 和 `ComSpec`。这会导致 Node.js 执行脚本时在 `ncrypto::CSPRNG(nullptr, 0)` 断言退出，也会导致 Python、PowerShell HTTP 和 curl 报 Winsock 服务提供程序初始化失败。

`scripts/run.ps1` 仅在当前进程中补齐缺失变量，随后执行项目命令。无需重新安装 Node.js、重置 Winsock、修改注册表或更改系统安全设置。原有的代理配置也会保留。

如果直接运行命令而不使用脚本，可在该 PowerShell 会话里先设置：

```powershell
$env:SystemRoot = 'C:\Windows'
$env:WINDIR = 'C:\Windows'
$env:ComSpec = 'C:\Windows\System32\cmd.exe'
```

然后使用当前 Node/npm，或 Codex 附带的匹配 Node/pnpm。旧版 Codex PATH 中的 `pnpm.cmd` 可能指向不存在的模块；辅助脚本会绕开该入口。

## 外部服务

页面构建、本地 Worker 与样例闭环不需要外部凭据。真实图片识别和实时生成需要 DeepSeek，云端账号与存储需要 Supabase；按主 README 配置 `.env.local`。未配置凭据时，样例回放与提供方模拟测试均不代表外部服务实连验证。
