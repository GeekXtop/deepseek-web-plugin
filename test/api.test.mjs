import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideRetry, extractApiErrorMessage, createRateLimiter, createApiClient,
} from '../server.mjs'

/** 构造 Response 序列的 stub fetch，记录每次调用。 */
function stubFetch(responses, log = []) {
  let i = 0
  return async (url, options) => {
    log.push({ url, options })
    const spec = responses[Math.min(i++, responses.length - 1)]
    if (spec.throw) throw spec.throw
    return new Response(spec.body !== undefined ? spec.body : JSON.stringify(spec.payload ?? {}),
      { status: spec.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
}

function makeClient(fetchImpl, { delayImpl = async () => {}, apiKey = 'sk-test', baseUrl = 'https://api.deepseek.com/v1/tools' } = {}) {
  return createApiClient({ baseUrl, apiKey, fetchImpl, delayImpl, limiter: createRateLimiter(0) })
}

test('decideRetry 只对 408/429/5xx 重试', () => {
  for (const s of [408, 429, 500, 503]) assert.equal(decideRetry(s), true, String(s))
  for (const s of [200, 400, 401, 402, 404]) assert.equal(decideRetry(s), false, String(s))
})

test('extractApiErrorMessage 三种上游形状', () => {
  assert.equal(extractApiErrorMessage({ error: 'str' }), 'str')
  assert.equal(extractApiErrorMessage({ error: { message: 'm' } }), 'm')
  assert.equal(extractApiErrorMessage({ message: 'mm' }), 'mm')
  assert.equal(extractApiErrorMessage({}), '')
})

test('limiter 强制请求起始间隔', async () => {
  const limiter = createRateLimiter(50)
  await limiter.acquire()
  const start = Date.now()
  await limiter.acquire()
  assert.ok(Date.now() - start >= 40, `间隔不足: ${Date.now() - start}ms`)
})

test('search 成功：URL、四件套 headers、redirect:error、body 字段', async () => {
  const log = []
  const client = makeClient(stubFetch([{ payload: { results: [{ url: 'https://a', title: 'T', snippet: 's', date: null }] } }], log))
  const sources = await client.search('q1', '原始问题')
  assert.deepEqual(sources, [{ url: 'https://a', title: 'T', snippet: 's' }])
  const { url, options } = log[0]
  assert.equal(url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'authorization', 'content-type', 'user-agent'])
  assert.equal(options.headers.authorization, 'Bearer sk-test')
  assert.equal(options.headers['user-agent'], 'deepseek-web-plugin/0.1.0')
  const body = JSON.parse(options.body)
  assert.deepEqual(body, { query: 'q1', count: 8, need_content: false, ori_question: '原始问题' })
})

test('search 的 oriQuestion 缺省时不带 ori_question 字段', async () => {
  const log = []
  const client = makeClient(stubFetch([{ payload: { results: [] } }], log))
  await client.search('q1')
  const body = JSON.parse(log[0].options.body)
  assert.deepEqual(body, { query: 'q1', count: 8, need_content: false })
})

test('search 429 一次后成功：注入延迟 1000ms 且不真 sleep', async () => {
  const delays = []
  const client = makeClient(stubFetch([
    { status: 429, body: '{"error":"rate limited"}' },
    { payload: { results: [{ url: 'https://a', title: '', snippet: '', date: null }] } },
  ]), { delayImpl: async (ms) => { delays.push(ms) } })
  const sources = await client.search('q1')
  assert.deepEqual(sources, [{ url: 'https://a' }])
  assert.deepEqual(delays, [1000])
})

test('search 三连 429：重试两次后抛错，延迟序列 1000/2000', async () => {
  const delays = []
  const client = makeClient(stubFetch([
    { status: 429, body: '{"error":"rate limited"}' },
  ]), { delayImpl: async (ms) => { delays.push(ms) } })
  await assert.rejects(() => client.search('q1'), /HTTP 429/)
  assert.deepEqual(delays, [1000, 2000])
})

test('search 402/401/400 的专属错误文案且不泄漏 key', async () => {
  const mk = (status, body) => makeClient(stubFetch([{ status, body }]), { apiKey: 'sk-SUPER-SECRET' })
  await assert.rejects(() => mk(402, '{"error":"insufficient"}').search('q'),
    err => err.message === 'DeepSeek API 余额不足（HTTP 402）：请充值后重试。')
  await assert.rejects(() => mk(401, '{"error":"bad key"}').search('q'),
    err => err.message === 'DeepSeek API 鉴权失败（HTTP 401）：请检查 DEEPSEEK_API_KEY。')
  await assert.rejects(() => mk(400, '{"error":{"message":"bad query"}}').search('q'),
    err => err.message === 'DeepSeek API 错误（HTTP 400）：bad query')
  for (const [status, body] of [[402, '{"error":"x"}'], [401, '{}'], [400, '{"error":{"message":"y"}}']]) {
    await assert.rejects(() => mk(status, body).search('q'), (err) => {
      assert.ok(!String(err).includes('sk-SUPER-SECRET'))
      return true
    })
  }
})

test('search 400 无可提取 detail 时消息无尾随冒号', async () => {
  const client = makeClient(stubFetch([{ status: 400, body: 'not json' }]))
  await assert.rejects(() => client.search('q'), err => err.message === 'DeepSeek API 错误（HTTP 400）')
})

test('fetch 抛错（含重定向被拒）映射为请求失败', async () => {
  const client = makeClient(stubFetch([{ throw: new TypeError('redirect') }]))
  await assert.rejects(() => client.search('q'), err => err.message === 'DeepSeek 请求失败：redirect')
})

test('search 畸形响应体抛 invalid response', async () => {
  for (const spec of [{ payload: {} }, { payload: { results: 'x' } }, { status: 200, body: 'not json' }]) {
    const client = makeClient(stubFetch([spec]))
    await assert.rejects(() => client.search('q'), /invalid response body/)
  }
})

test('fetchPage 成功返回 content，缺 content 抛错', async () => {
  const log = []
  const client = makeClient(stubFetch([{ payload: { title: 'T', content: '# 页' } }], log))
  assert.equal(await client.fetchPage('https://x'), '# 页')
  assert.equal(log[0].url, 'https://api.deepseek.com/v1/tools/fetch')
  assert.deepEqual(JSON.parse(log[0].options.body), { url: 'https://x' })
  const bad = makeClient(stubFetch([{ payload: { title: 'T' } }]))
  await assert.rejects(() => bad.fetchPage('https://x'), /invalid response body/)
})
