// Unit tests for the snapshot logic. Run: node --test tests/
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyMeasure,
  applyStep,
  localDay,
  newSession,
  parseAck,
  parseSlot,
  prepareWrite,
  profileId,
  restore,
  touch,
  usageRoot,
  isWsl,
  wslUsageRoot,
  type Ack,
  type SessionState,
  type Snapshot,
  type StepUsage,
} from '../hooks/core.ts'

const T0 = Date.parse('2026-11-07T10:00:00.000Z')
const IST = 330

function fresh(nowMs = T0, startedMs = T0 - 1000): SessionState {
  return newSession({ sessionId: 's1', profile: 'p1', generation: 'g1', nowMs, sessionStartedMs: startedMs })
}

function usage(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): StepUsage {
  return { model, input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite }
}

function write(state: SessionState, nowMs = T0, ack: Ack | null = null): Snapshot {
  const w = prepareWrite(state, { nowMs, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack })
  w.commit()
  return JSON.parse(w.text)
}

test('a request lands in its model and day bucket, with the four counters apart', () => {
  const s = fresh()
  applyStep(s, { key: 't1:0:', requestedModel: 'opus', usage: usage('claude-opus-5-5', 100, 400, 1000, 50), finishedAtMs: T0, utcOffsetMinutes: IST })
  const snap = write(s)
  assert.equal(snap.buckets.length, 1)
  assert.deepEqual(
    { ...snap.buckets[0] },
    {
      day: '2026-11-07',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      call_kind: 'main',
      input_uncached: 100,
      cache_read: 1000,
      cache_write: 50,
      output: 400,
      reasoning: null,
      requests: 1,
      requests_without_usage: 0,
      modified_seq: 1,
    },
  )
  assert.equal(snap.write_complete, true)
  assert.equal(snap.coverage.complete, true)
})

test('a model switch within one turn is attributed per request', () => {
  const s = fresh()
  applyStep(s, { key: 't1:0:', requestedModel: 'opus', usage: usage('claude-opus-5-5', 10, 20), finishedAtMs: T0, utcOffsetMinutes: IST })
  applyStep(s, { key: 't1:1:', requestedModel: 'haiku', usage: usage('claude-haiku-5-5', 1, 2), finishedAtMs: T0, utcOffsetMinutes: IST })
  const models = write(s).buckets.map(b => [b.model, b.output])
  assert.deepEqual(models, [['claude-haiku-5-5', 2], ['claude-opus-5-5', 20]])
})

test('the same request is never counted twice', () => {
  const s = fresh()
  const step = { key: 't1:0:', requestedModel: 'opus', usage: usage('claude-opus-5-5', 10, 20), finishedAtMs: T0, utcOffsetMinutes: IST }
  assert.equal(applyStep(s, step), true)
  assert.equal(applyStep(s, step), false)
  assert.equal(write(s).buckets[0].requests, 1)
})

test('subagent requests are their own call kind', () => {
  const s = fresh()
  applyStep(s, { key: 't1:0:a1', requestedModel: 'opus', agentId: 'a1', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  assert.equal(write(s).buckets[0].call_kind, 'subagent')
})

test('a request without usage counts, and leaves its counters unknown, not zero', () => {
  const s = fresh()
  applyStep(s, { key: 't1:0:', requestedModel: 'claude-opus-5-5', usage: null, finishedAtMs: T0, utcOffsetMinutes: IST })
  const b = write(s).buckets[0]
  assert.equal(b.requests, 1)
  assert.equal(b.requests_without_usage, 1)
  assert.equal(b.output, null)
  assert.equal(b.input_uncached, null)
})

test('the day is the local date when the request finished', () => {
  // 20:00 UTC is 01:30 the next day in India.
  assert.equal(localDay(Date.parse('2026-11-07T20:00:00Z'), IST), '2026-11-08')
  assert.equal(localDay(Date.parse('2026-11-07T20:00:00Z'), -300), '2026-11-07')
})

test('slots alternate, and seq rises by one each write', () => {
  const s = fresh()
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  const first = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  assert.equal(first.slot, 'a')
  assert.equal(first.seq, 1)
  first.commit()
  applyStep(s, { key: 'k2', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  const second = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  assert.equal(second.slot, 'b')
  assert.equal(second.seq, 2)
})

test('a failed write changes nothing: the retry goes to the same slot with the same seq', () => {
  const s = fresh()
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  write(s)
  applyStep(s, { key: 'k2', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  const failed = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  // no commit: the write failed
  const retry = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  assert.equal(retry.slot, failed.slot)
  assert.equal(retry.seq, failed.seq)
  assert.equal(retry.text, failed.text)
})

test('modified_seq names the write that last changed each bucket', () => {
  const s = fresh()
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  write(s)
  applyStep(s, { key: 'k2', requestedModel: 'm', usage: usage('claude-haiku-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  const snap = write(s)
  const bySeq = Object.fromEntries(snap.buckets.map(b => [b.model, b.modified_seq]))
  assert.deepEqual(bySeq, { 'claude-opus-5-5': 1, 'claude-haiku-5-5': 2 })
})

test('a bucket is dropped only with an exact, covering acknowledgment and after 35 days', () => {
  const old = Date.parse('2026-09-01T10:00:00Z')
  const now = Date.parse('2026-11-07T10:00:00Z')
  const make = () => {
    const s = fresh(old, old - 1000)
    applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: old, utcOffsetMinutes: IST })
    write(s, old)
    applyStep(s, { key: 'k2', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: now, utcOffsetMinutes: IST })
    return s
  }
  const ack: Ack = { format: 'softhalo.ack/1', app: 'claude-code', profile: 'p1', session_id: 's1', writer_generation: 'g1', seq: 1 }
  assert.deepEqual(write(make(), now, ack).buckets.map(b => b.day), ['2026-11-07'])
  assert.equal(write(make(), now, ack).buckets_since, '2026-11-07')
  for (const wrong of [{ writer_generation: 'g2' }, { profile: 'p2' }, { session_id: 's2' }, { app: 'codex' }]) {
    assert.equal(write(make(), now, { ...ack, ...wrong }).buckets.length, 2, JSON.stringify(wrong))
  }
  assert.equal(write(make(), now, null).buckets.length, 2)
})

test('an acknowledgment below a bucket\'s modified_seq keeps it', () => {
  const old = Date.parse('2026-09-01T10:00:00Z')
  const now = Date.parse('2026-11-07T10:00:00Z')
  const s = fresh(old, old - 1000)
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: old, utcOffsetMinutes: IST })
  write(s, old)
  applyStep(s, { key: 'k2', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: old, utcOffsetMinutes: IST })
  write(s, old) // the old bucket is now modified_seq 2
  const ack: Ack = { format: 'softhalo.ack/1', app: 'claude-code', profile: 'p1', session_id: 's1', writer_generation: 'g1', seq: 1 }
  assert.equal(write(s, now, ack).buckets.length, 1)
})

test('quota windows keep their observed time until a value changes', () => {
  const s = fresh()
  const reading = { rateLimits: [{ kind: 'five_hour', percentUsed: 43, resetsAt: '2026-11-07T13:00:00Z' }] }
  assert.equal(applyMeasure(s, reading, T0), true)
  assert.equal(applyMeasure(s, reading, T0 + 60_000), false)
  assert.equal(s.limits?.windows[0].observed_at, new Date(T0).toISOString())
  applyMeasure(s, { rateLimits: [{ kind: 'five_hour', percentUsed: 44, resetsAt: '2026-11-07T13:00:00Z' }] }, T0 + 120_000)
  assert.equal(s.limits?.windows[0].observed_at, new Date(T0 + 120_000).toISOString())
  assert.equal(s.limits?.state, 'available')
})

test('a window that disappears is omitted, and one without a reset time is never written', () => {
  const s = fresh()
  applyMeasure(s, { rateLimits: [{ kind: 'five_hour', percentUsed: 43, resetsAt: '2026-11-07T13:00:00Z' }, { kind: 'seven_day', percentUsed: 7 }] }, T0)
  assert.deepEqual(s.limits?.windows.map(w => w.window), ['five_hour'])
  applyMeasure(s, { rateLimits: [] }, T0 + 1000)
  assert.deepEqual(s.limits?.windows, [])
  assert.equal(s.limits?.state, 'unknown')
})

test('cost is recorded as the host\'s own estimate', () => {
  const s = fresh()
  applyMeasure(s, { rateLimits: [], costUsd: 1.25 }, T0)
  const snap = write(s)
  assert.equal(snap.cost_usd, 1.25)
  assert.equal(snap.cost_source, 'host')
  assert.equal(snap.limits, undefined)
})

test('a plugin started mid-session marks coverage partial', () => {
  const s = fresh(T0, T0 - 3_600_000)
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  const snap = write(s)
  assert.equal(snap.coverage.complete, false)
  assert.equal(snap.coverage.collected_since, new Date(T0).toISOString())
})

test('restore continues the newest slot\'s generation and skips requests it already holds', () => {
  const s = fresh()
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 5, 5), finishedAtMs: T0, utcOffsetMinutes: IST })
  const a = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  a.commit()
  applyStep(s, { key: 'k2', requestedModel: 'm', usage: usage('claude-opus-5-5', 5, 5), finishedAtMs: T0, utcOffsetMinutes: IST })
  const b = prepareWrite(s, { nowMs: T0 + 1, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  b.commit()

  const back = restore({ a: a.text, b: b.text }, 's1', 'p1')
  assert.ok(back)
  assert.equal(back.generation, 'g1')
  assert.equal(back.seq, 2)
  assert.equal(back.lastSlot, 'b')
  assert.equal(applyStep(back, { key: 'k2', requestedModel: 'm', usage: usage('claude-opus-5-5', 5, 5), finishedAtMs: T0, utcOffsetMinutes: IST }), false)
  applyStep(back, { key: 'k3', requestedModel: 'm', usage: usage('claude-opus-5-5', 5, 5), finishedAtMs: T0, utcOffsetMinutes: IST })
  const next = prepareWrite(back, { nowMs: T0 + 2, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  assert.equal(next.slot, 'a')
  assert.equal(next.seq, 3)
  assert.equal(JSON.parse(next.text).buckets[0].output, 15)
})

test('a damaged slot means a new generation, never a reused seq', () => {
  const s = fresh()
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 5, 5), finishedAtMs: T0, utcOffsetMinutes: IST })
  const a = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  assert.equal(restore({ a: a.text, b: a.text.slice(0, 40) }, 's1', 'p1'), null)
  assert.equal(restore({ a: null, b: null }, 's1', 'p1'), null)
  assert.equal(parseSlot('{"format":"softhalo.claude-snapshot/3"}', 's1'), 'invalid')
  assert.equal(parseSlot(a.text, 'other-session'), 'invalid')
})

test('the usage folder follows each system\'s convention', () => {
  assert.equal(usageRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local\\' }, false), 'C:\\Users\\u\\AppData\\Local/Softhalo/usage')
  assert.equal(usageRoot({ HOME: '/Users/u' }, true), '/Users/u/Library/Application Support/Softhalo/usage')
  assert.equal(usageRoot({ HOME: '/home/u', XDG_STATE_HOME: '/home/u/.state' }, false), '/home/u/.state/softhalo/usage')
  assert.equal(usageRoot({ HOME: '/home/u', XDG_STATE_HOME: 'relative' }, false), '/home/u/.local/state/softhalo/usage')
  assert.equal(usageRoot({}, false), null)
})

test('inside WSL the Windows user with a Soft Halo folder is found', () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }), true)
  assert.equal(isWsl({}), false)
  const users = '/mnt/c/Users/'
  assert.equal(wslUsageRoot(users, ['Tarun', 'Public'], 'tarun-linux'), '/mnt/c/Users/Tarun/AppData/Local/Softhalo/usage')
  assert.equal(wslUsageRoot(users, ['Tarun', 'Ann'], 'ann'), '/mnt/c/Users/Ann/AppData/Local/Softhalo/usage')
  assert.equal(wslUsageRoot(users, ['Tarun', 'Ann'], 'bob'), null)
  assert.equal(wslUsageRoot(users, ['Default'], 'u'), null)
  assert.equal(wslUsageRoot(users, [], 'u'), null)
})

test('the profile id is stable, opaque and ignores separators and case', async () => {
  const one = await profileId('C:\\Users\\U\\.claude\\')
  assert.equal(one, await profileId('c:/users/u/.claude'))
  assert.match(one, /^cfg-[0-9a-f]{20}$/)
  assert.notEqual(one, await profileId('/home/u/.claude'))
})

test('a malformed acknowledgment is ignored', () => {
  assert.equal(parseAck('{"format":"softhalo.ack/1"}'), null)
  assert.equal(parseAck('not json'), null)
  assert.equal(parseAck(null), null)
})

test('cost is split by the local day each increase happened on', () => {
  const s = fresh()
  // 23:00 and 00:30 in India: two different local days.
  applyMeasure(s, { rateLimits: [], costUsd: 1.0, utcOffsetMinutes: IST }, Date.parse('2026-11-07T17:30:00Z'))
  applyMeasure(s, { rateLimits: [], costUsd: 1.75, utcOffsetMinutes: IST }, Date.parse('2026-11-07T19:00:00Z'))
  const snap = write(s, Date.parse('2026-11-07T19:00:05Z'))
  assert.deepEqual(snap.cost_by_day, [
    { day: '2026-11-07', cost_usd: 1 },
    { day: '2026-11-08', cost_usd: 0.75 },
  ])
  assert.equal(snap.cost_usd, 1.75)
})

test('a writer that joined mid-session takes its first cost reading as a baseline only', () => {
  const s = fresh(T0, T0 - 3_600_000) // started an hour before the plugin saw it
  applyMeasure(s, { rateLimits: [], costUsd: 5, utcOffsetMinutes: IST }, T0)
  applyMeasure(s, { rateLimits: [], costUsd: 5.5, utcOffsetMinutes: IST }, T0 + 60_000)
  assert.deepEqual(write(s).cost_by_day, [{ day: '2026-11-07', cost_usd: 0.5 }])
})

test('a running cost that starts over counts the new reading in full', () => {
  const s = fresh()
  applyMeasure(s, { rateLimits: [], costUsd: 2, utcOffsetMinutes: IST }, T0)
  applyMeasure(s, { rateLimits: [], costUsd: 0.25, utcOffsetMinutes: IST }, T0 + 1000)
  assert.deepEqual(write(s).cost_by_day, [{ day: '2026-11-07', cost_usd: 2.25 }])
})

test('restore keeps the cost so far and counts only new spend', () => {
  const s = fresh()
  applyMeasure(s, { rateLimits: [], costUsd: 1, utcOffsetMinutes: IST }, T0)
  const first = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  first.commit()
  const back = restore({ a: first.text, b: null }, 's1', 'p1')
  assert.ok(back)
  applyMeasure(back, { rateLimits: [], costUsd: 1.5, utcOffsetMinutes: IST }, T0 + 1000)
  assert.deepEqual(write(back, T0 + 2000).cost_by_day, [{ day: '2026-11-07', cost_usd: 1.5 }])
})

test('a request recorded while a write is in flight is kept for the next write', () => {
  const s = fresh()
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 10), finishedAtMs: T0, utcOffsetMinutes: IST })
  const inFlight = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  // While the file write awaits: a new model, and more usage on the bucket being written.
  applyStep(s, { key: 'k2', requestedModel: 'm', usage: usage('claude-haiku-5-5', 1, 5), finishedAtMs: T0, utcOffsetMinutes: IST })
  applyStep(s, { key: 'k3', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 20), finishedAtMs: T0, utcOffsetMinutes: IST })
  inFlight.commit()

  assert.equal(s.dirty, true)
  const next = JSON.parse(prepareWrite(s, { nowMs: T0 + 1, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null }).text) as Snapshot
  const byModel = Object.fromEntries(next.buckets.map(b => [b.model, b]))
  assert.equal(byModel['claude-haiku-5-5'].output, 5)
  assert.equal(byModel['claude-opus-5-5'].output, 30)
  assert.equal(byModel['claude-opus-5-5'].modified_seq, 2)
})

test('a session end during a write still gets its final write', () => {
  const s = fresh()
  applyStep(s, { key: 'k1', requestedModel: 'm', usage: usage('claude-opus-5-5', 1, 1), finishedAtMs: T0, utcOffsetMinutes: IST })
  const inFlight = prepareWrite(s, { nowMs: T0, utcOffsetMinutes: IST, pluginVersion: '1.0.0', ack: null })
  s.ended = true
  touch(s)
  inFlight.commit()
  assert.equal(s.dirty, true)
  assert.equal(write(s, T0 + 1).session_ended, true)
})

test('requests with and without usage in one bucket mark its counters as partial', () => {
  const s = fresh()
  applyStep(s, { key: 'k1', requestedModel: 'claude-opus-5-5', usage: usage('claude-opus-5-5', 10, 20), finishedAtMs: T0, utcOffsetMinutes: IST })
  applyStep(s, { key: 'k2', requestedModel: 'claude-opus-5-5', usage: null, finishedAtMs: T0, utcOffsetMinutes: IST })
  const b = write(s).buckets[0]
  assert.equal(b.output, 20)
  assert.deepEqual(b.incomplete, ['cache_read', 'cache_write', 'input_uncached', 'output'])

  const t = fresh()
  applyStep(t, { key: 'k1', requestedModel: 'claude-opus-5-5', usage: null, finishedAtMs: T0, utcOffsetMinutes: IST })
  applyStep(t, { key: 'k2', requestedModel: 'claude-opus-5-5', usage: usage('claude-opus-5-5', 10, 20), finishedAtMs: T0, utcOffsetMinutes: IST })
  assert.deepEqual(write(t).buckets[0].incomplete, ['cache_read', 'cache_write', 'input_uncached', 'output'])

  const u = fresh()
  applyStep(u, { key: 'k1', requestedModel: 'claude-opus-5-5', usage: usage('claude-opus-5-5', 10, 20), finishedAtMs: T0, utcOffsetMinutes: IST })
  assert.equal(write(u).buckets[0].incomplete, undefined)
})
