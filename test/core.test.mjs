import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boundQuestion, truncateSummary, parseSearchArgs, mergeSearchResults,
  formatSearchOutput, formatFetchOutput, SEARCH_NOTICE, FETCH_NOTICE,
} from '../server.mjs'

const a = { url: 'https://a.example/1' }
const b = { url: 'https://b.example/2' }
const c = { url: 'https://c.example/3' }

test('boundQuestion 折叠空白并按码点截 128，不切半个代理对', () => {
  const q = 'x'.repeat(120) + '\n' + '😀'.repeat(10) // 折叠后 131 码点
  const out = boundQuestion(q)
  assert.equal([...out].length, 128)
  assert.equal([...out].at(-1), '😀')
  assert.ok(!out.includes('\n'))
})

test('boundQuestion 纯空白返回 undefined', () => {
  assert.equal(boundQuestion('  \n\t '), undefined)
  assert.equal(boundQuestion(undefined), undefined)
})

test('truncateSummary 按码点截 800 含省略号', () => {
  const s = 'y'.repeat(795) + '😀'.repeat(6) // 801 码点
  const out = truncateSummary(s)
  assert.equal([...out].length, 800)
  assert.equal([...out].at(-1), '…')
  assert.equal([...out][798], '😀')
})

test('truncateSummary 短文本折叠空白后原样返回', () => {
  assert.equal(truncateSummary('a\n\nb\tc'), 'a b c')
})

test('parseSearchArgs 四类非法输入的错误消息', () => {
  assert.throws(() => parseSearchArgs({ queries: [] }),
    /queries must contain at least one query/)
  assert.throws(() => parseSearchArgs({ queries: 'x' }),
    /queries must contain at least one query/)
  assert.throws(() => parseSearchArgs({ queries: ['a', 'b', 'c', 'd', 'e'] }),
    /queries must contain at most 4 queries/)
  assert.throws(() => parseSearchArgs({ queries: ['a', '   '] }),
    /each query must be a non-empty string/)
})

test('parseSearchArgs 去重保序', () => {
  assert.deepEqual(parseSearchArgs({ queries: ['a', 'b', 'a', 'c'] }).queries, ['a', 'b', 'c'])
})

test('parseSearchArgs 处理 ori_question：非字符串忽略，字符串经 boundQuestion', () => {
  assert.equal(parseSearchArgs({ queries: ['a'] }).oriQuestion, undefined)
  assert.equal(parseSearchArgs({ queries: ['a'], ori_question: 42 }).oriQuestion, undefined)
  assert.equal(parseSearchArgs({ queries: ['a'], ori_question: 'p\n\nq' }).oriQuestion, 'p q')
})

test('mergeSearchResults round-robin 按 URL 去重', () => {
  const r = mergeSearchResults([[a, b], [b, c]])
  assert.deepEqual(r.sources, [a, b, c])
  assert.equal(r.truncated, false)
})

test('mergeSearchResults 满 cap 停并标记 truncated', () => {
  const r = mergeSearchResults([[a, b], [b, c]], 2)
  assert.deepEqual(r.sources, [a, b])
  assert.equal(r.truncated, true)
})

test('mergeSearchResults 空输入是成功空结果', () => {
  assert.deepEqual(mergeSearchResults([]), { sources: [], truncated: false })
})

test('formatSearchOutput 空来源输出提示与引用要求', () => {
  const out = formatSearchOutput({ sources: [], truncated: false })
  assert.ok(out.includes(SEARCH_NOTICE))
  assert.ok(out.includes('没有搜索结果。'))
  assert.ok(out.includes('Markdown 链接'))
})

test('formatSearchOutput 来源行格式', () => {
  const out = formatSearchOutput({
    sources: [
      { url: 'https://example.com/x', title: 'T', summary: 'S', publishedAt: '2026-01-01' },
      { url: 'https://example.com/2', snippet: 'SN' },
    ],
    truncated: false,
  })
  assert.ok(out.includes(SEARCH_NOTICE))
  assert.ok(out.includes('- [T](https://example.com/x) — S (2026-01-01)'))
  assert.ok(out.includes('- [example.com](https://example.com/2) — SN'))
})

test('formatSearchOutput truncated 提示条数', () => {
  const out = formatSearchOutput({ sources: [a, b], truncated: true })
  assert.ok(out.includes('(仅显示前 2 条来源，请精炼 query。)'))
})

test('formatSearchOutput 无 title 用 hostname，坏 URL 回退原文', () => {
  const out = formatSearchOutput({ sources: [{ url: 'not a url' }], truncated: false })
  assert.ok(out.includes('- [not a url](not a url)'))
})

test('formatFetchOutput 头部与正文', () => {
  const out = formatFetchOutput('https://x.example', 'BODY')
  assert.ok(out.includes('已抓取 https://x.example (HTTP 200)'))
  assert.ok(out.includes(FETCH_NOTICE))
  assert.ok(out.includes('BODY'))
})

test('formatFetchOutput 超长截断加注且总长不超 50000', () => {
  const out = formatFetchOutput('https://x.example', 'z'.repeat(60000))
  assert.ok(out.length <= 50000)
  assert.ok(out.includes('(内容已截断。请抓取更具体的 URL 或页面片段。)'))
})

test('formatFetchOutput 截断不切半个代理对（奇/偶两种预算口径都覆盖）', () => {
  const mk = padLen => 'x'.repeat(padLen) + '😀'.repeat(10000)
  for (const [url, padLen] of [['https://x.example', 40000], ['https://x.example2', 40001]]) {
    const out = formatFetchOutput(url, mk(padLen))
    const stripped = out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, '')
    assert.ok(!/[\uD800-\uDFFF]/u.test(stripped), `url=${url} 输出含孤立代理对`)
    assert.ok(out.length <= 50000)
    assert.ok(out.includes('(内容已截断'))
  }
})
