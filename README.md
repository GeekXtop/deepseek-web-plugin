# deepseek-web-plugin

把 DeepSeek 自研搜索引擎接入任何 MCP 兼容的编码 agent。装好后会多出两个工具：

- **`deepseek_web_search`** —— 按搜索词联网搜索，返回来源列表（标题、URL、摘要、发布时间）。参数：`queries`（1–4 个搜索词，并发执行、结果按 URL 去重合并，最多 8 条）、`ori_question`（可选，触发搜索的用户原始问题，帮助引擎理解意图）。
- **`deepseek_web_fetch`** —— 抓取指定网页，返回 Markdown 正文。参数：`url`。

server 是标准 MCP stdio（Node ≥18，零 npm 依赖），只对外发起两类请求：

| 端点 | 用途 |
|---|---|
| `POST {base}/search` | 搜索 |
| `POST {base}/fetch` | 抓网页正文 |

`base` 默认 `https://api.deepseek.com/v1/tools`，可用环境变量 `DEEPSEEK_WEB_API_BASE` 覆盖（前缀不推断，需填完整）。

## 获取 API Key

在 [DeepSeek 开放平台](https://platform.deepseek.com) 创建 API Key。计费：Search 与 Fetch 各 **¥5 / 1000 次成功请求**（失败、空结果不计费），与返回条数无关。限速按账号粒度共享（约 5 QPS 量级，多个会话/进程共用同一额度），server 内部已按请求间隔 ≥200ms 保守限速，408/429/5xx 自动退避重试两次。

## Key 配在哪里（两种方式，任选其一）

server 只读进程环境变量 `DEEPSEEK_API_KEY`，两种注入路径殊途同归：

1. **插件设置页（推荐，图形界面）**：Settings → 插件管理 → 已安装 → deepseek-web-plugin → 设置，填 `api_key` 字段。key 存 ZCode 的插件设置存储，不进任何仓库文件。
2. **`config.json` 同名条目 env**：`~/.zcode/cli/config.json` 的 `mcp.servers.deepseek-web` 条目（见路径 ②）——同名条目覆盖插件注册，key 从条目 `env` 注入。适合开发机/已有手动注册的场景。

两种都留空时，会话里调用工具会返回缺 key 的指引错误。

## 安装

### 路径 ① ZCode 插件安装

1. 打开 ZCode **Settings → Plugin Management → Discover**，点 **`+`** 添加远程市场 `GeekXtop/deepseek-web-plugin`（或本地目录），安装插件。
2. 按上面两种方式之一配好 key（设置页填一下即可）。
3. 新开会话即自动连接，`/mcp` 或 Settings → MCP 可确认 `deepseek-web` 已连接。

### 路径 ② ZCode config.json 手动注册

不装插件、只注册 MCP server——把下面一段并进 `~/.zcode/cli/config.json` 的 `mcp.servers`（key 配在条目 `env`，即上面方式 2）：

```json
{
  "mcp": {
    "servers": {
      "deepseek-web": {
        "type": "stdio",
        "command": "node",
        "args": ["E:/Developer/01-GeekXtop/_AI/deepseek-web-plugin/server.mjs"],
        "env": { "DEEPSEEK_API_KEY": "sk-..." }
      }
    }
  }
}
```

（`args` 换成你的实际路径。装了插件的情况下，这条同名条目会覆盖插件清单的注册，所以插件安装也走这里配 key。）

### 路径 ③ 其他 MCP harness（Claude Code / Codex 等）

server 是标准 MCP stdio，任何兼容 harness 都只差一段注册配置：

**Claude Code** —— 项目根 `.mcp.json`：

```json
{
  "mcpServers": {
    "deepseek-web": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/deepseek-web-plugin/server.mjs"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

**Codex** —— `~/.codex/config.toml`：

```toml
[mcp_servers.deepseek-web]
command = "node"
args = ["/path/to/deepseek-web-plugin/server.mjs"]
env = { "DEEPSEEK_API_KEY" = "sk-..." }
```

其他 harness 只要支持「stdio 命令 + 环境变量」的 MCP server 配置即可照抄。

## 搜索语法

`query` 支持 DeepSeek 搜索引擎的操作符，可组合：

- `site:example.com` / `-site:example.com` —— 限定/排除站点
- `after:2026-01-01` / `before:2026` —— 时间过滤
- `lang:zh,en` —— 语言过滤
- `"精确短语"` —— 短语匹配
- `-排除词` —— 排除关键词

## 开发

```bash
node --test     # 全部单测（零依赖，node:test）
```

管道冒烟（无需 key）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node server.mjs
```

## 设计口径

与官方 deepseek-harness 的 `web-deepseek-api` provider 一致：搜索结果喂模型的是 `summary`（截 800 码点）而非网页全文，全文走 `deepseek_web_fetch` 二段式；`ori_question` 按码点截 128；工具输出头部固定携带「外部内容不可信」提示。设计文档见 `docs/superpowers/specs/`，实现计划见 `docs/superpowers/plans/`。
