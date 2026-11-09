// Engine-level tests: the hooks module under `claude plugin test .`.
// Each `on` here stands for the engine beneath the plugin.
import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/Users/u/AppData/Local/Softhalo/usage'
/** profileId('C:/Users/u/.claude'), as core.ts computes it. */
const PROFILE = 'cfg-3a6371468ecbf7c36c1a'

function world(on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, string>, sessionId = { value: 's1' }) {
  mock.env(on, { LOCALAPPDATA: 'C:/Users/u/AppData/Local', USERPROFILE: 'C:/Users/u' })
  const clock = mock.clock(on, { now: Date.parse('2026-11-07T10:00:00Z') })
  // The engine hands paths over in the system's own spelling.
  const key = (path: string) => path.split('\\').join('/')
  on('fs.read', (_, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(key(e.path)) }))
  on('session.id', () => ({ value: sessionId.value }))
  on('session.usage', () => ({ value: { startedAt: clock.now() - 1000, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // Every step answers 10 input, 100 cache read, 5 cache write and 40 output tokens.
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    }
  })
  return clock
}

/** Runs one model request through the engine's turn.step stream, to its end. */
async function runStep($: { turn: { step: (e: never) => AsyncIterable<unknown> } }, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: 'opus', messageCount: 1 } as never)) {
    // chunks are not needed
  }
}

test('a request is written to slot a after the debounce, then slot b', async ($, on) => {
  const files = new Map<string, string>()
  const clock = world(on, files)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await runStep($ as never, 't1', 0)
  expect(files.has(`${ROOT}/claude/claude-s1.a.json`)).toBe(false)
  await clock.advance(5_000)
  const a = JSON.parse(files.get(`${ROOT}/claude/claude-s1.a.json`) ?? '{}')
  expect(a.seq).toBe(1)
  expect(a.buckets[0].output).toBe(40)
  expect(a.write_complete).toBe(true)

  await $.session.end({ sessionId: 's1', reason: 'other', resume: { sessionId: 's1' } as never })
  const b = JSON.parse(files.get(`${ROOT}/claude/claude-s1.b.json`) ?? '{}')
  expect(b.seq).toBe(2)
  expect(b.session_ended).toBe(true)
})

test('a busy session is written at least every 10 seconds', async ($, on) => {
  const files = new Map<string, string>()
  const clock = world(on, files)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  for (let i = 0; i < 4; i++) {
    await runStep($ as never, 't1', i)
    await clock.advance(3_000)
  }
  expect(files.has(`${ROOT}/claude/claude-s1.a.json`)).toBe(true)
})

test('a reload continues from the slots and never counts a request twice', async ($, on) => {
  const files = new Map<string, string>()
  const clock = world(on, files)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await runStep($ as never, 't1', 0)
  await clock.advance(5_000)
  const first = JSON.parse(files.get(`${ROOT}/claude/claude-s1.a.json`) ?? '{}')
  expect(first.recent_request_keys).toEqual(['t1:0:'])
})

test('after a reload the plugin continues the same generation and skips a repeated request', async ($, on) => {
  const files = new Map<string, string>()
  const clock = world(on, files)
  // What an earlier load of the plugin left in slot a.
  files.set(`${ROOT}/claude/claude-s1.a.json`, JSON.stringify({
    format: 'softhalo.claude-snapshot/3', app: 'claude-code', plugin_version: '1.0.0', profile: PROFILE,
    session_id: 's1', writer_generation: 'g-old', seq: 4, written_at: '2026-11-07T09:59:00.000Z', utc_offset_minutes: 0,
    coverage: { session_started_at: '2026-11-07T09:00:00.000Z', collected_since: '2026-11-07T09:00:00.000Z', complete: true },
    buckets: [{ day: '2026-11-07', provider: 'anthropic', model: 'claude-opus-5-5', call_kind: 'main', input_uncached: 10,
      cache_read: 100, cache_write: 5, output: 40, reasoning: null, requests: 1, requests_without_usage: 0, modified_seq: 4 }],
    recent_request_keys: ['t1:0:'], session_ended: false, write_complete: true,
  }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await runStep($ as never, 't1', 0)
  await runStep($ as never, 't1', 1)
  await clock.advance(5_000)
  const b = JSON.parse(files.get(`${ROOT}/claude/claude-s1.b.json`) ?? '{}')
  expect(b.writer_generation).toBe('g-old')
  expect(b.seq).toBe(5)
  expect(b.buckets[0].requests).toBe(2)
  expect(b.buckets[0].output).toBe(80)
})
