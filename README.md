# LocalMCP - 榨干 ChatGPT 的所有价值

让 ChatGPT 网页端使用你的本机开发能力：文件操作、Shell、持久进程、Skills 和可插拔 MCP Server。

![LocalMCP 工作原理：ChatGPT 经 Cloudflare Worker 中继，连接本机 Agent 和工具](localmcp.png)

本机主动通过 WebSocket 连接 Cloudflare Worker，由 Worker 负责认证与请求中继，无需公网 IP 或开放入站端口。

## 快速开始

需要 **Node.js 22+**。

```sh
npm install -g @daodao97/localmcp
localmcp
```

首次运行会自动创建 `~/.localmcp/` 配置、向默认公共 Worker 注册独立设备，并在后台启动 Agent。连接成功后会输出完整 MCP URL，关闭终端不会停止服务。

在 ChatGPT 中添加 MCP 连接，服务器 URL 填入输出的完整地址，身份验证选择 **None**。

> 完整 MCP URL 包含访问凭证，请勿公开分享或提交到 Git。

## 常用命令

```sh
localmcp          # 启动后台服务，重复执行会复用已有进程
localmcp status   # 查看状态、MCP URL 和日志路径
localmcp stop     # 停止后台服务
localmcp reload   # 校验并重新加载配置
localmcp agent    # 前台运行，便于调试
```

日志位于 `~/.localmcp/agent.log`。也支持 `localmcp stdio`，或通过 `LOCALMCP_TOKEN=<至少32字符的密钥> localmcp http` 启动本地 HTTP 服务。

## 配置与扩展

编辑 `~/.localmcp/localmcp.json`，然后运行 `localmcp reload`。以下示例配置工作区并开启 Shell：

```json
{
  "workspaces": {
    "project": "/Users/me/code/project"
  },
  "defaultWorkspace": "project",
  "features": {
    "files": true,
    "shell": true,
    "processes": true
  },
  "skills": {
    "dir": "skills",
    "enabled": ["local-development"]
  },
  "mcpServers": {}
}
```

- **多工作区**：在 `workspaces` 中添加路径，调用工具时用 `workspace` 选择；省略时使用默认工作区。
- **Skills**：将操作说明放入 `~/.localmcp/skills/<名称>/SKILL.md`，并在 `skills.enabled` 中启用。
- **MCP 扩展**：在 `mcpServers` 中配置标准 MCP Server，例如下方的 Computer Use 服务；工具会带上 `computer_` 前缀。

```json
{
  "mcpServers": {
    "computer": {
      "enabled": true,
      "command": "cua-driver",
      "args": ["mcp"]
    }
  }
}
```

完整配置示例见 [localmcp.example.json](localmcp.example.json)。可通过 `LOCALMCP_CONFIG` 指定其他配置文件。

## 自建 Worker（可选）

将中继部署到自己的 Cloudflare 账号，再让本机 LocalMCP 连接它。需要 Cloudflare 和 GitHub 账号。

### 1. 部署到 Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/daodao97/localmcp)

点击按钮，按提示登录、连接 GitHub 并创建仓库，然后点击 **Deploy**。Cloudflare 会根据仓库配置部署 Worker 和 SQLite Durable Object，无需手动创建数据库或填写密钥。按钮流程见 [Cloudflare 官方说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

部署成功后，在 Worker 的 **Settings → Domains & Routes** 中复制 `workers.dev` 地址，例如 `https://localmcp-relay.YOUR-SUBDOMAIN.workers.dev`。

<details>
<summary>也可以通过命令行部署</summary>

```sh
git clone https://github.com/daodao97/localmcp.git
cd localmcp
npm ci
npx wrangler login
npm run worker:deploy
```

复制命令输出中的 Worker 地址，然后继续下面的连接步骤。

</details>

### 2. 连接本机

安装 LocalMCP，并用你的 Worker 地址启动：

```sh
npm install -g @daodao97/localmcp
LOCALMCP_WORKER_URL=https://localmcp-relay.YOUR-SUBDOMAIN.workers.dev localmcp
```

首次连接会自动注册设备，将地址和凭证保存到 `~/.localmcp/worker.json`；之后直接运行 `localmcp` 即可，无需再设置环境变量，也无需运行 `worker:setup` 或 `worker:secrets`。

**如果已经连接过公共 Worker 或其他 Worker**，先停止服务并备份旧凭证，再执行上面的启动命令。仅修改环境变量不会重新注册设备：

```sh
localmcp stop
mv ~/.localmcp/worker.json ~/.localmcp/worker.json.backup-$(date +%Y%m%d%H%M%S)
LOCALMCP_WORKER_URL=https://localmcp-relay.YOUR-SUBDOMAIN.workers.dev localmcp
```

### 3. 在 ChatGPT 中使用

运行 `localmcp status`，复制输出的完整 MCP URL（包含 `/mcp/<设备ID>/<密钥>`），在 ChatGPT 的 MCP 连接中填写该 URL，身份验证选择 **None**。切换 Worker 后，需要同步更新 ChatGPT 中的服务器 URL。

保持本机在线、LocalMCP 后台服务运行，即可让 ChatGPT 调用本机工具。连接失败时，先用下面的命令确认 Worker 正常，再检查 `localmcp status` 和 `~/.localmcp/agent.log`：

```sh
curl https://localmcp-relay.YOUR-SUBDOMAIN.workers.dev/healthz
# 预期：{"ok":true,"service":"localmcp-relay","registration":true}
```

自建 Worker 默认也开放设备注册；每台设备使用独立凭证，部署在你账号下的请求和资源用量由该账号承担。

## 安全边界

文件工具限制在配置的工作区内，但 LocalMCP **不是 OS 沙箱**：Shell 和外部 MCP Server 可拥有当前用户权限。Worker 会转发文件内容、命令结果及工具返回的数据。请仅配置可信的工作区和 MCP Server。

## 开发

```sh
npm ci
npm run check
npm test
npm run build
```

## License

ISC
