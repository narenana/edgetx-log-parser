import { describe, it, expect } from 'vitest'
import { buildFeedbackBody, feedbackContext, sendFeedback, FEEDBACK_MAX_COMMENT } from './feedback'

describe('buildFeedbackBody — the exact JSON that leaves the browser', () => {
  it('carries only product, rating, comment, context and the empty honeypot', () => {
    const body = buildFeedbackBody({ rating: 9, comment: '  Love the globe  ', context: 'sample' })
    expect(body).toEqual({ product: 'log-viewer', rating: 9, comment: 'Love the globe', context: 'sample', website: '' })
  })
  it('caps the comment and drops an unknown context', () => {
    const body = buildFeedbackBody({ rating: 3, comment: 'x'.repeat(FEEDBACK_MAX_COMMENT + 50), context: 'C:/logs/pilot.bbl' })
    expect(body.comment).toHaveLength(FEEDBACK_MAX_COMMENT)
    expect(body.context).toBe('')
  })
})

describe('feedbackContext', () => {
  const samples = new Set(['Sample fixed wing.csv'])
  it('landing when no log is open', () => {
    expect(feedbackContext(undefined, samples)).toBe('landing')
  })
  it('sample when a built-in flight is open', () => {
    expect(feedbackContext({ filename: 'Sample fixed wing.csv', debrief: { context: { source: 'edgetx-csv' } } }, samples)).toBe('sample')
  })
  it("uses the debrief's source, else the extension", () => {
    expect(feedbackContext({ filename: 'LOG00057.TXT', debrief: { context: { source: 'blackbox' } } }, samples)).toBe('blackbox')
    expect(feedbackContext({ filename: 'Model-2026-04-26-101500.csv' }, samples)).toBe('edgetx-csv')
    expect(feedbackContext({ filename: 'btfl_001.bbl' }, samples)).toBe('blackbox')
  })
})

describe('sendFeedback', () => {
  const fakeFetch = (impl) => {
    const calls = []
    const f = async (url, init) => { calls.push({ url, init }); return impl() }
    f.calls = calls
    return f
  }

  it('POSTs text/plain JSON without credentials and reports success', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200 }))
    expect(await sendFeedback({ rating: 8, comment: 'hi', context: 'landing' }, { fetchImpl: f })).toEqual({ ok: true })
    const { url, init } = f.calls[0]
    expect(url).toBe('https://www.narenana.com/api/feedback')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    expect(init.headers['content-type']).toBe('text/plain')
    expect(JSON.parse(init.body)).toEqual({ product: 'log-viewer', rating: 8, comment: 'hi', context: 'landing', website: '' })
  })

  it('maps 429 to rate, other failures to server, throws to network', async () => {
    expect(await sendFeedback({ rating: 5 }, { fetchImpl: fakeFetch(() => ({ ok: false, status: 429 })) })).toEqual({ ok: false, error: 'rate' })
    expect(await sendFeedback({ rating: 5 }, { fetchImpl: fakeFetch(() => ({ ok: false, status: 500 })) })).toEqual({ ok: false, error: 'server' })
    expect(await sendFeedback({ rating: 5 }, { fetchImpl: fakeFetch(() => { throw new TypeError('Failed to fetch') }) })).toEqual({ ok: false, error: 'network' })
  })
})
