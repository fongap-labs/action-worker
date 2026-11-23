import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createModernWebGuidanceTool, findModernWebGuides } from
  '#target/packages/delta-code/lib/delta-code-adapter/providers/dsh/modern-web-guidance.js'
import { MODERN_WEB_GUIDES, MODERN_WEB_GUIDANCE_REVISION } from
  '#target/packages/delta-code/lib/delta-code-strategy/modern-web-guidance-index.js'
import { shouldSuggestModernWebGuidance } from
  '#target/packages/delta-code/lib/delta-code-strategy/modern-web-task-policy.js'

const context = () => ({ signal: new AbortController().signal })
function entry(text, id = 'responsive-table') {
  const bytes = Buffer.from(text)
  return { id, path: 'skills/modern-web-guidance/guides/ui-atoms/' + id + '.md',
    blobSha: createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'),
    bytes: bytes.length }
}

describe('Delta Code pinned Modern Web Guidance', () => {
  it('reviews a complete immutable source index without duplicate or unsafe paths', () => {
    assert.match(MODERN_WEB_GUIDANCE_REVISION, /^[a-f0-9]{40}$/)
    assert.ok(MODERN_WEB_GUIDES.length >= 200)
    const names = new Set()
    for (const guide of MODERN_WEB_GUIDES) {
      assert.match(guide.id, /^[a-z0-9-]+$/)
      assert.match(guide.path, /^skills\/modern-web-guidance\/guides\/[a-z0-9/-]+\.md$/)
      assert.match(guide.blobSha, /^[a-f0-9]{40}$/)
      assert.ok(Number.isSafeInteger(guide.bytes) && guide.bytes > 0 && guide.bytes <= 65536)
      assert.equal(names.has(guide.id), false, guide.id)
      names.add(guide.id)
    }
    assert.ok(findModernWebGuides('navigation drawer').some(guide => guide.id === 'navigation-drawer'))
    assert.ok(findModernWebGuides('responsive table').some(guide => guide.id === 'responsive-table'))
    assert.deepEqual(findModernWebGuides('plain rust unit tests'), [])
  })

  it('only suggests guidance for substantial browser work and respects opt-outs', () => {
    assert.equal(shouldSuggestModernWebGuidance('Fix dialog keyboard focus'), true)
    assert.equal(shouldSuggestModernWebGuidance('\u4f18\u5316 CSS \u54cd\u5e94\u5f0f\u5e03\u5c40'), true)
    assert.equal(shouldSuggestModernWebGuidance('fix backend Rust CI'), false)
    assert.equal(shouldSuggestModernWebGuidance('rename a CSS variable'), false)
    assert.equal(shouldSuggestModernWebGuidance('Fix CSS modal without network'), false)
    assert.equal(shouldSuggestModernWebGuidance('\u4e0d\u8981\u8054\u7f51\uff0c\u4fee\u590d\u9875\u9762\u4fa7\u680f'), false)
  })

  it('searches locally, then fetches only the exact pinned guide with verified bytes', async () => {
    const body = '# Responsive Table\n\nPrefer responsive, accessible native tables.'
    const approved = entry(body)
    let count = 0
    const fetcher = async (url, init) => {
      count++
      assert.equal(url, 'https://raw.githubusercontent.com/GoogleChrome/modern-web-guidance/' +
        MODERN_WEB_GUIDANCE_REVISION + '/' + approved.path)
      assert.equal(init.redirect, 'error')
      return new Response(body, { status: 200 })
    }
    const tool = createModernWebGuidanceTool(fetcher, [approved])
    const found = await tool.execute({ action: 'search', query: 'responsive table' }, context())
    assert.deepEqual(found.matches, [{ id: approved.id, path: approved.path }])
    assert.equal(count, 0, 'query text must not leave the Host')
    const loaded = await tool.execute({ action: 'retrieve', guideId: approved.id }, context())
    assert.equal(loaded.content, body)
    assert.equal(loaded.hasMore, false)
    assert.equal(count, 1)
    const again = await tool.execute({ action: 'retrieve', guideId: approved.id }, context())
    assert.equal(again.content, body)
    assert.equal(count, 1, 'task-scoped verified content cache should avoid duplicate reads')
    await assert.rejects(tool.execute({ action: 'retrieve', guideId: '../secrets' }, context()),
      /not in the pinned/)
    assert.equal(count, 1)
  })

  it('reads long guides in bounded chunks without accepting truncated or tampered sources', async () => {
    const body = '# Guide\n' + 'a'.repeat(25000)
    const approved = entry(body)
    const good = createModernWebGuidanceTool(async () => new Response(body), [approved])
    const first = await good.execute({ action: 'retrieve', guideId: approved.id }, context())
    assert.equal(first.content.length, 12000)
    assert.equal(first.hasMore, true)
    const second = await good.execute({ action: 'retrieve', guideId: approved.id, offset: first.nextOffset }, context())
    assert.equal(second.nextOffset, 24000)
    assert.equal(second.hasMore, true)
    const last = await good.execute({ action: 'retrieve', guideId: approved.id, offset: second.nextOffset }, context())
    assert.equal(last.hasMore, false)
    await assert.rejects(good.execute({ action: 'retrieve', guideId: approved.id, offset: -1 }, context()), /Invalid guide offset/)
    const tampered = createModernWebGuidanceTool(async () => new Response(body.replace('Guide', 'Other')), [approved])
    await assert.rejects(tampered.execute({ action: 'retrieve', guideId: approved.id }, context()), /mismatch/)
    const missing = createModernWebGuidanceTool(async () => new Response('Not found', { status: 404 }), [approved])
    await assert.rejects(missing.execute({ action: 'retrieve', guideId: approved.id }, context()), /HTTP 404/)
    const oversize = 'x'.repeat(65537)
    const sizeBound = createModernWebGuidanceTool(async () => new Response(oversize), [entry(oversize)])
    await assert.rejects(sizeBound.execute({ action: 'retrieve', guideId: approved.id }, context()), /bounded size/)
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(toolCallCancelled(good, approved.id, cancelled.signal), /cancelled/)
  })
})

async function toolCallCancelled(tool, guideId, signal) {
  return tool.execute({ action: 'retrieve', guideId }, { signal })
}
