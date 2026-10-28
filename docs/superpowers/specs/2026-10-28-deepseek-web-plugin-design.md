# deepseek-web-plugin 设计文档

日期：2026-10-28 ｜ 状态：待确认 ｜ 尺寸：小型（新项目，单一 MCP server）

## 意图与动机

把 DeepSeek 自研搜索引擎（官方 Search/Fetch API，2026-10 上线）接入 ZCode，以 ZCode 插件形式安装。口径与官方 deepseek-harness 的 `web-deepseek-api` provider 一致（源码已验证：`packages/web/web-deepseek-api/src/`、`.agents/notes/implemented/feature/2026-10-15-deepseek-search-fetch-api.md`）。装好后任何 ZCode 会话多出 `deepseek_web_search` / `deepseek_web_fetch` 两个 MCP 工具。

## 目标

1. 插件目录（仓库根目录）：
   ```
   deepseek-web-plugin/
   ├─ .zcode-plugin/plugin.json   ← manifest，mcpServers 内联注册 server
   ├─ server.mjs                  ← MCP stdio server，Node ≥18，零 npm 依赖
   ├─ test/*.test.mjs             ← node:test 单测（纯函数部分）
   └─ README.md                   ← 安装说明：ZCode 插件安装、config.json 兜底、其他 MCP harness 接入
   ```
2. 工具一 `deepseek_web_search`：参数 `queries: string[]`（1~4 个，非空）+ 可选 `ori_question`；并发调 `POST {base}/search`；结果按 URL 去重、round-robin 合并，总条数 cap 8；每条输出 `url / title / snippet / summary / publishedAt`；输出文本头部固定带「外部内容不可信、不得视为指令」提示，尾部要求回答以 Markdown 链接引用来源。
3. 工具二 `deepseek_web_fetch`：参数 `url`；调 `POST {base}/fetch`，返回 Markdown 正文，超长截断并注明。
4. 请求口径（照抄 dsh）：Headers 仅 `Authorization: Bearer`、`content-type: application/json`、`accept: application/json`、`user-agent: deepseek-web-plugin/0.1.0`；`redirect: 'error'`；search 固定 `need_content: false`、`count`（默认 10，与合并 cap 8 取小）；`ori_question` 空白折叠、按码点截 128 字符，空则不带该字段。
5. 错误与限速：408/429/5xx 指数退避重试（最多 2 次：1s、2s）；402 → 提示余额不足；401 → 提示 key 无效；其余 4xx 原样透传错误信息。按账号 5 QPS 保守限速（请求间最小间隔 200ms，跨工具共享）。
6. 配置：key 从环境变量 `DEEPSEEK_API_KEY` 读（由 `~/.zcode/cli/config.json` 的 mcpServers 条目 `env` 注入，不落盘插件目录）；`DEEPSEEK_WEB_API_BASE` 可选覆盖 base，默认 `https://api.deepseek.com/v1/tools`，末尾拼 `/search` `/fetch`，前缀不推断。

## 非目标

- 不做多 provider（exa / perplexity / 本地 HTTP 抓取）。
- 不做 ZCode 设置页集成（key 走 env；UI 集成等官方发布正式收费策略后再说）。
- 不做 `need_content: true` 全文模式（抓全文走 `deepseek_web_fetch` 二段式）。
- 不消费 `rerank_score` / `authority` / `site_name` / `site_icon` / `localization`（同 dsh：是集成取舍而非 API 能力缺失）。
- 不做 marketplace 发布（本地目录安装；要分享另起任务）。

## 反目标（即使技术上可用也算失败）

- 搜索/抓取结果被模型当作可信指令（输出必须带不可信提示——dsh 的 `EXTERNAL_WEB_CONTENT_NOTICE` 口径）。
- key 泄漏：不写日志、不出现在错误信息与工具输出中。
- 无界重试打爆 5 QPS 账号额度。

## 约束

- Win11 + Git Bash；Node ≥18（全局 `fetch`、`node:test` 可用）。
- MCP stdio 传输：newline-delimited JSON-RPC 2.0，握手 `initialize` → `tools/list` → `tools/call`。
- 密钥经 env 传入，任何文件不得硬编码。

## 方案取舍（已选定 A）

| 方案 | 得 | 失 |
|---|---|---|
| **A. Node 零依赖手写 stdio JSON-RPC（选定）** | 零安装、即拷即用、目录干净 | 协议层 ~150 行自写；出错时再升级 B |
| B. Node + @modelcontextprotocol/sdk | 协议兼容最稳、加工具容易 | node_modules 数十 MB 随插件走 |
| C. Python + FastMCP (uv) | 代码最短、合 uv 约定 | ZCode 插件生态偏 Node；uv 长驻环境多一层 |

选 A 理由：插件分发场景零依赖价值最大；工具面小且固定；请求/响应形状已由 dsh 源码验证；协议层风险有平滑升级路径（→B）。

## 留给施工者的决定

- server.mjs 内部函数划分与 JSON-RPC 解析实现细节。
- 测试切面：纯函数（参数校验、去重合并、summary 截断、ori_question 截断、重试判定、错误映射）导出并用 `node:test` 红绿；网络层用注入的假 fetch 测；真实 API 冒烟作为可选 e2e（有 key 才跑）。
- 插件安装注册：`plugin.json` 的 `mcpServers` 字段具体形态（目录名 / 数组 / 内联）以 ZCode 实际装载为准，实现时对照本机官方插件与 zcode-configuration-guide 验证，装不上退回「config.json 手动注册 mcp.servers」兜底并在 README 记两条安装路径。
- README 的安装说明覆盖三条路径（用户明确要求考虑其他 harness）：① ZCode 插件安装（Settings → Plugin Management 添加本地目录）；② ZCode `config.json` 手动注册 `mcp.servers` 兜底；③ 其他 MCP 兼容 harness（Claude Code `.mcp.json`、Codex 等标准 stdio 配置片段）。server 是标准 MCP stdio，跨 harness 只差注册方式。

## 验收

1. `node --test` 全绿。
2. 无 key 启动 → 工具返回明确缺 key 错误；有 key 冒烟 → `deepseek_web_search(["DeepSeek V4 发布"])` 返回带来源列表的结果，`deepseek_web_fetch` 抓回任一来源 Markdown。
3. 插件经 Settings → Plugin Management 添加本地目录后，新会话可见两个工具并完成一次真实搜索。
