# localmcp

ChatGPT 网页版通过固定 Worker URL 调用本机文件、开发命令和 computer use。

```text
ChatGPT ── HTTPS MCP ──> Cloudflare Worker + Durable Object
                                      ⇅ WebSocket
                             本地 agent 主动连接
                                      ↓
                             本地 MCP / 文件 / Shell / GUI
```

借鉴 hostc 的反向连接方式，独立实现 MCP 专用中继；不依赖 hostc 服务或 cloudflared。Worker 只转发 MCP，不执行本地开发操作，不接受任意目标 URL。本地无需公网 IP 或入站端口。相同 Worker 的 URL 在本地重连后保持不变。

## 首次部署

需要 Node.js 22+、npm 和 Cloudflare 账号（Worker + SQLite Durable Objects）。

```sh
npm ci
npm run build
npx wrangler login
npm run worker:setup
npm run worker:deploy
npm run worker:secrets
# 使用 deploy 输出的实际 Worker 域名：
npm run worker:setup -- https://localmcp-relay.YOUR-SUBDOMAIN.workers.dev
```

`worker:setup` 生成两份独立的随机密钥，保存在权限为 0600 的 `.localmcp/worker.json`：本地 agent 使用连接密钥，ChatGPT 使用 MCP URL 密钥。`worker:secrets` 仅把两份密钥的 SHA-256 摘要上传到你自己的 Worker。未配置密钥时 Worker 拒绝访问。不要提交 `.localmcp`；仓库已忽略该目录。

默认 Worker 名称为 `localmcp-relay`，可在 `worker/wrangler.jsonc` 修改。部署到已有同名 Worker 会更新它，首次使用应确保名称属于此项目。

## 启动本地 agent

```sh
LOCALMCP_ROOT=/absolute/path/to/project LOCALMCP_SHELL=1 npm start
```

仅文件功能可直接 `npm start`。命令执行和 computer use 默认关闭，设置为 `1` 开启。computer use 需要安装 `cua-driver` 并授予其辅助功能、屏幕录制权限。

启动后打印完整 MCP URL，保存到 `.localmcp/connection.json`。保持进程运行；Ctrl+C 关闭 agent 和它管理的本地 MCP 服务。重新运行后使用同一个 Worker URL 和密钥。

在 ChatGPT“新插件”填写：

- 名称：`localmcp`
- 描述：`在我的本地工作目录创建和修改文件、执行开发命令、操作本机应用。`
- 连接：**服务器 URL**，填入完整 `https://localmcp-relay.…workers.dev/mcp/<密钥>`
- 身份验证：**无 / None**（本版本无 OAuth，完整 URL 是访问凭证）

创建后检查工具列表，在新对话中启用插件。示例：“创建 hello.txt，内容是 hello localmcp，再读回来验证。”

完整 URL 能调用你启用的本地能力，请勿公开分享。Worker 通过 HTTPS/WSS 转发文件内容、命令结果和 GUI 图片；数据会经过你部署的 Cloudflare 服务。密钥摘要不是 OAuth 用户权限系统，本版本适合个人单机使用。

## 连接行为

- Worker 用一个 Durable Object 管理一台本机。已经在线时，第二个 agent 连接被拒绝。
- 连接掉线后指数退避重连，最长约 31 秒。心跳检查失效连接。
- 本机离线返回 503；忙碌返回 429；调用超时返回 504；中途断线返回 502。
- 不自动重放请求。502/504 后本地操作可能已经发生，应先查看结果，避免重复写入或执行命令。
- HTTP 使用 MCP Streamable HTTP JSON 响应模式；不提供旧版 `/sse`，不提供服务器主动通知流。
- HTTP 输入上限 2 MiB，中继结果上限 8 MiB，WebSocket 分片传输。一次执行一个请求，不缓存业务内容。大截图超过限制会明确报错。
- Worker 请求等待上限 130 秒，本地转发上限 125 秒；网络/平台/ChatGPT 可能有更短的请求期限。长任务应拆分。
- `/healthz` 只说明 Worker 存活，不代表本地 agent 在线。

## 工具

| 工具 | 功能 |
| --- | --- |
| `workspace_info` | 工作目录和启用能力 |
| `list_directory` / `workspace_tree` | 分页列目录 / 递归查看项目树 |
| `find_files` / `search_files` | 按文件名模式查找 / 搜索文本内容 |
| `stat_path` | 查看文件或目录元数据 |
| `read_file` / `read_file_lines` | 读取 UTF-8 文件 / 按行读取 |
| `write_file` | 创建文件；覆盖使用原子替换 |
| `edit_file` / `apply_patch` | 精确字符串替换 / 带可选 SHA-256 并发保护的多行编辑 |
| `create_directory` / `delete_path` / `move_path` | 工作区内基础文件管理 |
| `run_command` | 一次性 shell 命令、退出码、输出与超时状态 |
| `start_process` / `read_process` / `write_process` / `stop_process` / `list_processes` | 持久开发进程、增量日志和 stdin |
| `computer_*` | 转发 cua-driver 的原生 schema 与结果，包括图片 |

computer use 工具列表由已安装驱动动态发现。驱动缺失或无法启动时，启用 GUI 能力的 MCP 初始化会失败；检查驱动安装及系统授权。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOCALMCP_ROOT` | 当前目录 | 文件工作目录，必须存在 |
| `LOCALMCP_SHELL` | 关闭 | `1` 开启命令执行 |
| `LOCALMCP_CUA_COMMAND` | `cua-driver` | GUI 驱动路径 |
| `LOCALMCP_WORKER_URL` | worker.json | 覆盖 Worker origin，正式连接须 HTTPS |
| `LOCALMCP_AGENT_PORT` | `8788` | agent 管理的回环 MCP 服务端口 |
| `LOCALMCP_PORT` | `8787` | 独立 HTTP / Quick Tunnel 端口 |
| `LOCALMCP_TOKEN` | 无 | 独立 HTTP 必填；agent 自动生成内部密钥 |

文件工具拒绝目录穿越和符号链接，写入拒绝多重硬链接。这是应用层检查，**不是 OS 沙箱**，不防御本地恶意进程并发修改目录的竞争。

shell 和 computer use 具有 OS 用户权限，可以访问工作目录之外的资源。shell 不继承服务密钥环境变量，但可读取本机用户能读取的文件。一次性命令输出上限 256 KiB、执行上限 120 秒。启用 shell 后也可启动由 LocalMCP 管理的持久进程；每个 stdout/stderr 环形缓冲最多保留约 1 MiB，agent 退出时会终止仍在运行的托管进程。文件直接修改，无自动回滚，建议使用 Git。

## 更新和轮换

```sh
npm run build
npm run check
npm test
npm run worker:deploy
```

重启本地 agent 加载新的本地代码。轮换密钥：先停止 agent，备份/移除 `.localmcp/worker.json`，运行 setup 重新生成并填写原域名，运行 `worker:secrets`，重启 agent，更新 ChatGPT URL。两份密钥应一起轮换。旧版本 Worker/agent 协议目前不保证兼容，更新时一起升级。

## 其他连接方式

- `npm run stdio`：标准 MCP stdio。
- 设置 `LOCALMCP_TOKEN` 后 `npm run http`：本地 HTTP `/mcp` 支持 Bearer；`/mcp/<密钥>` 支持 URL 凭证。
- `npm run start:quick`：保留 Cloudflare Quick Tunnel 兼容启动方式，需要 cloudflared，每次启动公网域名可能变化。

## 验证

`npm test` 包含文件边界、覆盖保护、命令超时、SDK stdio/HTTP 测试，以及在本机真实 workerd/Durable Object 模拟器上运行 Worker → WebSocket → agent → MCP 的端到端测试。测试用临时目录和测试密钥，不发送真实工作文件到公网。

参考：[hostc 架构](https://github.com/akazwz/hostc#architecture)、[Cloudflare Durable Object WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[ChatGPT MCP 接入](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

## Skills 与 MCP 扩展

LocalMCP Core 只提供工作区文件、Shell/持久进程和 Worker relay。额外能力通过 Skill + 标准 MCP Server 扩展。Skill 是 `SKILL.md` 使用说明，MCP Server 提供真正的 tools；两者都通过 `localmcp.json` 配置。


### `localmcp.json`

推荐把 LocalMCP 自身功能、Skills 和 MCP 的启用状态统一放在项目根目录的 `localmcp.json`：

```json
{
  "root": ".",
  "features": { "files": true, "shell": true, "processes": true },
  "skills": { "dir": "skills", "enabled": ["computer-use"] },
  "mcpServers": {
    "computer": { "enabled": true, "command": "cua-driver", "args": ["mcp"] }
  }
}
```

`enabled: false` 可关闭某个 MCP；`skills.enabled` 是 Skill allowlist。`LOCALMCP_CONFIG=/path/to/localmcp.json` 可指定其他配置文件。配置启动时使用 Zod 严格校验，未知字段、缺少 MCP `command` 或类型错误都会直接给出配置错误。仓库提供 `localmcp.example.json` 作为模板。部署相关的 token、端口等敏感/运行时值仍使用环境变量，避免写入配置文件。

### 多工作区

`localmcp.json` 可以声明多个固定工作区；不需要运行时 add/remove/switch。每个文件、Shell 和启动进程工具都接受可选 `workspace` 参数，不传时使用 `defaultWorkspace`：

```json
{
  "workspaces": {
    "localmcp": "/Users/me/code/localmcp",
    "app": "/Users/me/code/app"
  },
  "defaultWorkspace": "localmcp"
}
```

使用 `list_workspaces` 查看已配置工作区。旧的单 `root` 配置仍兼容，并会映射成名为 `default` 的工作区。
