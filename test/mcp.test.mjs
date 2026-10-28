import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createMcpServer, SERVER_INFO, TOOLS } from '../server.mjs'

const execFileAsync = promisify(execFile)

const SEARCH_NOTICE_HEADING = '不可信数据'

function recordingClient({ results = [], error } = {}) {
  const calls = []
  return {
    calls,
    async search(query, oriQuestion) {
      calls.push({ query, oriQuestion })
      if (error) throw error
      return typeof results === 'function' ? results(query) : results
    },
    async fetchPage(url) {
      calls.push({ url })
      if (error) throw error
      return `BODY of ${url}`
    },
  }
}

test('initialize 回显协议版本并带 serverInfo/capabilities', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const res = JSON.parse(await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })))
  assert.equal(res.id, 1)
  assert.equal(res.result.protocolVersion, '2025-06-18')
  assert.equal(res.result.serverInfo.name, SERVER_INFO.name)
  assert.equal(res.result.serverInfo.name, 'deepseek-web-plugin')
  assert.ok(res.result.capabilities.tools)
})

test('initialize 无协议版本参数时回退默认', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const res = JSON.parse(await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })))
  assert.equal(res.result.protocolVersion, '2025-06-18')
})

test('通知不回包', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  assert.equal(await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null)
})

test('tools/list 返回两个工具与 schema 要点', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const res = JSON.parse(await handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })))
  assert.deepEqual(res.result.tools.map(t => t.name), ['deepseek_web_search', 'deepseek_web_fetch'])
  const search = res.result.tools[0]
  assert.deepEqual(search.inputSchema.required, ['queries'])
  assert.equal(search.inputSchema.properties.queries.type, 'array')
  assert.deepEqual(res.result.tools[1].inputSchema.required, ['url'])
})

test('TOOLS 常量与 tools/list 同构，SERVER_INFO 版本与 manifest 一致', () => {
  assert.equal(TOOLS.length, 2)
  const manifest = JSON.parse(readFileSync(new URL('../.zcode-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.equal(SERVER_INFO.version, manifest.version)
})

test('search 调用：多 query 并发、共享 URL 去重、ori_question 经 boundQuestion', async () => {
  const s1 = { url: 'https://shared.example/1', title: 'A', snippet: 'x' }
  const s2 = { url: 'https://only-q1.example/2', title: 'B', snippet: 'y' }
  const s3 = { url: 'https://only-q2.example/3', title: 'C', snippet: 'z' }
  const apiClient = recordingClient({ results: q => (q === 'q1' ? [s1, s2] : [s1, s3]) })
  const handle = createMcpServer({ apiClient })
  const res = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'deepseek_web_search', arguments: { queries: ['q1', 'q2'], ori_question: 'a\n\nb' } },
  })))
  assert.equal(res.result.isError, undefined)
  assert.deepEqual(apiClient.calls, [
    { query: 'q1', oriQuestion: 'a b' },
    { query: 'q2', oriQuestion: 'a b' },
  ])
  const text = res.result.content[0].text
  assert.ok(text.includes(SEARCH_NOTICE_HEADING))
  assert.ok(text.includes('- [A](https://shared.example/1) — x'))
  for (const u of ['https://only-q1.example/2', 'https://only-q2.example/3']) assert.ok(text.includes(u))
  assert.ok(!text.includes('isError'))
})

test('search summary 超 800 码点被截断后进输出', async () => {
  const long = { url: 'https://a.example/1', title: 'A', snippet: '', summary: 's'.repeat(1000) }
  const handle = createMcpServer({ apiClient: recordingClient({ results: [long] }) })
  const res = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'deepseek_web_search', arguments: { queries: ['q'] } },
  })))
  const text = res.result.content[0].text
  assert.ok(text.includes(`${'s'.repeat(799)}…`))
  assert.ok(!text.includes('s'.repeat(1000)))
})

test('search 空结果 → 成功输出「没有搜索结果。」而非错误', async () => {
  const handle = createMcpServer({ apiClient: recordingClient({ results: [] }) })
  const res = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 13, method: 'tools/call',
    params: { name: 'deepseek_web_search', arguments: { queries: ['q'] } },
  })))
  assert.equal(res.result.isError, undefined)
  assert.ok(res.result.content[0].text.includes('没有搜索结果。'))
})

test('search 上游错误 → isError 文本为错误消息', async () => {
  const apiClient = recordingClient({ error: new Error('DeepSeek API 错误（HTTP 500）') })
  const handle = createMcpServer({ apiClient })
  const res = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'deepseek_web_search', arguments: { queries: ['q'] } },
  })))
  assert.equal(res.result.isError, true)
  assert.equal(res.result.content[0].text, 'DeepSeek API 错误（HTTP 500）')
})

test('无 key 场景 → isError 提示 DEEPSEEK_API_KEY', async () => {
  const apiClient = recordingClient({ error: new Error('未配置 DEEPSEEK_API_KEY：请在 mcpServers 条目的 env 中设置。') })
  const handle = createMcpServer({ apiClient })
  const res = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'deepseek_web_search', arguments: { queries: ['q'] } },
  })))
  assert.equal(res.result.isError, true)
  assert.ok(res.result.content[0].text.includes('DEEPSEEK_API_KEY'))
})

test('search 参数非法 → isError 带校验消息', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const res = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'deepseek_web_search', arguments: { queries: [] } },
  })))
  assert.equal(res.result.isError, true)
  assert.equal(res.result.content[0].text, 'queries must contain at least one query')
})

test('fetch 调用：返回抓取文本；空 url 报错', async () => {
  const apiClient = recordingClient()
  const handle = createMcpServer({ apiClient })
  const res = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'deepseek_web_fetch', arguments: { url: 'https://x.example' } },
  })))
  assert.equal(apiClient.calls[0].url, 'https://x.example')
  assert.ok(res.result.content[0].text.includes('已抓取 https://x.example (HTTP 200)'))
  assert.ok(res.result.content[0].text.includes('BODY of https://x.example'))

  const bad = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'deepseek_web_fetch', arguments: { url: '   ' } },
  })))
  assert.equal(bad.result.isError, true)
  assert.equal(bad.result.content[0].text, 'url must be a non-empty string')
})

test('未知工具 -32602、未知方法 -32601、坏 JSON -32700', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const unknownTool = JSON.parse(await handle(JSON.stringify({
    jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'nope', arguments: {} },
  })))
  assert.equal(unknownTool.error.code, -32602)
  const unknownMethod = JSON.parse(await handle(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'wat' })))
  assert.equal(unknownMethod.error.code, -32601)
  const badJson = JSON.parse(await handle('not json'))
  assert.equal(badJson.error.code, -32700)
  assert.equal(badJson.id, null)
})

test('ping 返回空结果', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const res = JSON.parse(await handle(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'ping' })))
  assert.deepEqual(res.result, {})
})

test('initialize 客户端版本不受支持时回服务端最新支持版', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const res = JSON.parse(await handle(JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'initialize', params: { protocolVersion: '2099-01-01' } })))
  assert.equal(res.result.protocolVersion, '2025-06-18')
})

test('initialize 结果带非空 instructions', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const res = JSON.parse(await handle(JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'initialize', params: {} })))
  assert.equal(typeof res.result.instructions, 'string')
  assert.ok(res.result.instructions.length > 0)
})

test('JSON-RPC 边缘形状：标量/批包 -32600，空行忽略，坏 JSON 仍 -32700', async () => {
  const handle = createMcpServer({ apiClient: recordingClient() })
  const scalar = JSON.parse(await handle('5'))
  assert.equal(scalar.error.code, -32600)
  const batch = JSON.parse(await handle('[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]'))
  assert.equal(batch.error.code, -32600)
  assert.equal(await handle(''), null)
  assert.equal(await handle('   '), null)
  const badJson = JSON.parse(await handle('{oops'))
  assert.equal(badJson.error.code, -32700)
})

test('argv[1] 为 undefined 的嵌入宿主 import server.mjs 不崩', async () => {
  const serverUrl = new URL('../server.mjs', import.meta.url).href
  try {
    const { stderr } = await execFileAsync(process.execPath, ['-e', `import(${JSON.stringify(serverUrl)})`])
    assert.equal(stderr, '')
  } catch (err) {
    assert.fail(`import 期崩溃：${err.stderr ?? err.message}`)
  }
})
