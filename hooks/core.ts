// Pure snapshot logic for the softhalo.claude-snapshot/3 format: no `$`, no
// I/O, so it runs the same under the engine and under `node --test`.
//
// The contract lives in "Soft Halo usage collection: spec" and the JSON
// Schemas beside Soft Halo's fixtures. In short: one session is written to two
// alternating slots; each version carries the session's cumulative buckets,
// a writer generation and a sequence number; buckets are trimmed only after
// Soft Halo has acknowledged them.

export const FORMAT = 'softhalo.claude-snapshot/3'
export const ACK_FORMAT = 'softhalo.ack/1'
export const APP = 'claude-code'
export const RECENT_KEYS_MAX = 500
export const PRUNE_AFTER_DAYS = 35
/** Readers reject a snapshot over 1 MiB; trimming starts below that. */
export const SOFT_MAX_BYTES = 900 * 1024
/** A session whose start is this close to the first collection counts as fully covered. */
export const FRESH_SESSION_MS = 120_000

export type Slot = 'a' | 'b'
export type CallKind = 'main' | 'subagent'
export type CounterName = 'input_uncached' | 'cache_read' | 'cache_write' | 'output' | 'reasoning'

export interface Bucket {
  day: string
  provider: string
  model: string
  call_kind: CallKind
  input_uncached: number | null
  cache_read: number | null
  cache_write: number | null
  output: number | null
  reasoning: number | null
  /** Counters whose value is a known partial sum: some requests in the bucket did not report them. */
  incomplete?: CounterName[]
  requests: number
  requests_without_usage: number
  modified_seq: number
}

export interface QuotaWindow {
  window: string
  used_pct: number
  resets_at: string
  observed_at: string
}

export interface Limits {
  state: 'available' | 'unknown'
  quota_key: null
  login_marker: null
  windows: QuotaWindow[]
}

export interface DayRange {
  from: string
  to: string
}

export interface DayCost {
  day: string
  cost_usd: number
}

export interface Snapshot {
  format: typeof FORMAT
  app: typeof APP
  app_version?: string
  plugin_version: string
  profile: string
  session_id: string
  writer_generation: string
  seq: number
  written_at: string
  utc_offset_minutes: number
  coverage: { session_started_at: string; collected_since: string; complete: boolean }
  buckets_since?: string
  unacked_pruned?: DayRange
  limits?: Limits
  cost_usd?: number | null
  cost_source?: 'host'
  cost_by_day?: DayCost[]
  buckets: Bucket[]
  recent_request_keys: string[]
  session_ended: boolean
  write_complete: true
}

export interface Ack {
  format: typeof ACK_FORMAT
  app: string
  profile: string
  session_id: string
  writer_generation: string
  seq: number
}

/** One session as the writer holds it between writes. */
export interface SessionState {
  sessionId: string
  profile: string
  generation: string
  /** The seq of the last version written; 0 before the first. */
  seq: number
  sessionStartedAt: string
  collectedSince: string
  buckets: Bucket[]
  /** Buckets changed since the last write, each with the revision of its latest change. */
  changed: Map<Bucket, number>
  /** Rises with every change; a write settles only the changes it actually carried. */
  revision: number
  recentKeys: string[]
  limits: Limits | null
  /** The session's running cost as Claude Code last reported it. */
  costUsd: number | null
  /** Spend per local day it accrued on, cumulative within this generation. */
  costByDay: Record<string, number>
  unackedPruned: DayRange | null
  ended: boolean
  /** The slot holding the newest valid version, or null before the first write. */
  lastSlot: Slot | null
  dirty: boolean
}

export interface StepUsage {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export interface Step {
  /** turn id + step index + agent id: unique per model request in a session. */
  key: string
  /** The model the request named; used when no usage (and so no answering model) came back. */
  requestedModel: string
  agentId?: string
  usage: StepUsage | null
  finishedAtMs: number
  utcOffsetMinutes: number
}

export interface RateLimitReading {
  kind: string
  percentUsed: number
  resetsAt?: string
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The local calendar date when something finished, by the offset at that moment. */
export function localDay(ms: number, utcOffsetMinutes: number): string {
  return new Date(ms + utcOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to`, both yyyy-mm-dd. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** The company that made the model, which is what Soft Halo groups by. */
export function providerOf(model: string): string {
  return /claude|anthropic/i.test(model) ? 'anthropic' : 'unknown'
}

export function newSession(args: {
  sessionId: string
  profile: string
  generation: string
  nowMs: number
  sessionStartedMs: number
}): SessionState {
  const startedAt = iso(args.sessionStartedMs)
  // A brand-new session is collected from its start; anything else (a resume,
  // a plugin installed mid-session) only from now, and is shown as Partial.
  const isFresh = args.nowMs - args.sessionStartedMs <= FRESH_SESSION_MS
  return {
    sessionId: args.sessionId,
    profile: args.profile,
    generation: args.generation,
    seq: 0,
    sessionStartedAt: startedAt,
    collectedSince: isFresh ? startedAt : iso(args.nowMs),
    buckets: [],
    changed: new Map(),
    revision: 0,
    recentKeys: [],
    limits: null,
    costUsd: null,
    costByDay: {},
    unackedPruned: null,
    ended: false,
    lastSlot: null,
    dirty: false,
  }
}

function addCounter(current: number | null, value: number): number {
  return current === null ? value : current + value
}

const SUMMABLE: CounterName[] = ['cache_read', 'cache_write', 'input_uncached', 'output']

/** Records that something changed, so the next write carries it and an in-flight write does not settle it. */
export function touch(state: SessionState, bucket?: Bucket): void {
  state.revision += 1
  if (bucket) state.changed.set(bucket, state.revision)
  state.dirty = true
}

/** Adds one model request. Returns false for a request already counted. */
export function applyStep(state: SessionState, step: Step): boolean {
  if (state.recentKeys.includes(step.key)) return false
  state.recentKeys.push(step.key)
  if (state.recentKeys.length > RECENT_KEYS_MAX) state.recentKeys.splice(0, state.recentKeys.length - RECENT_KEYS_MAX)

  const day = localDay(step.finishedAtMs, step.utcOffsetMinutes)
  const model = step.usage?.model || step.requestedModel || 'unknown'
  const provider = providerOf(model)
  const callKind: CallKind = step.agentId ? 'subagent' : 'main'
  let bucket = state.buckets.find(
    b => b.day === day && b.provider === provider && b.model === model && b.call_kind === callKind,
  )
  if (!bucket) {
    bucket = {
      day,
      provider,
      model,
      call_kind: callKind,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      output: null,
      reasoning: null,
      requests: 0,
      requests_without_usage: 0,
      modified_seq: 1,
    }
    state.buckets.push(bucket)
  }

  // Requests with and without usage in one bucket make its counters known
  // partial sums: Soft Halo must show "at least", not an exact total.
  const hadUsage = bucket.requests - bucket.requests_without_usage > 0
  const hadNoUsage = bucket.requests_without_usage > 0
  if ((step.usage === null && hadUsage) || (step.usage !== null && hadNoUsage)) bucket.incomplete = [...SUMMABLE]

  bucket.requests += 1
  if (step.usage === null) {
    bucket.requests_without_usage += 1
  } else {
    // The four buckets never overlap: input_tokens is already the uncached part.
    bucket.input_uncached = addCounter(bucket.input_uncached, step.usage.input_tokens)
    bucket.cache_read = addCounter(bucket.cache_read, step.usage.cache_read_input_tokens)
    bucket.cache_write = addCounter(bucket.cache_write, step.usage.cache_creation_input_tokens)
    bucket.output = addCounter(bucket.output, step.usage.output_tokens)
  }
  touch(state, bucket)
  return true
}

/**
 * How much of a new running-cost reading is new spend. The first reading of a
 * writer that did not see the session from its start is only a baseline: it
 * may include spend another generation already counted. A reading below the
 * last one means Claude Code's counter started over, so all of it is new.
 */
export function costIncrease(state: SessionState, costUsd: number): number {
  if (state.costUsd === null) {
    const isFullyCovered = Date.parse(state.collectedSince) <= Date.parse(state.sessionStartedAt)
    return isFullyCovered ? costUsd : 0
  }
  return costUsd >= state.costUsd ? costUsd - state.costUsd : costUsd
}

/** Records a quota and cost reading. Returns whether anything changed. */
export function applyMeasure(
  state: SessionState,
  reading: { rateLimits: readonly RateLimitReading[]; costUsd?: number; utcOffsetMinutes?: number },
  nowMs: number,
): boolean {
  let isChanged = false
  if (reading.rateLimits.length > 0 || state.limits !== null) {
    const previous = state.limits?.windows ?? []
    const windows: QuotaWindow[] = []
    for (const limit of reading.rateLimits) {
      // A window without a reset time can't be shown honestly; it is left out.
      if (!limit.resetsAt || Number.isNaN(Date.parse(limit.resetsAt))) continue
      const resetsAt = iso(Date.parse(limit.resetsAt))
      const usedPct = Math.min(100, Math.max(0, limit.percentUsed))
      const same = previous.find(w => w.window === limit.kind && w.used_pct === usedPct && w.resets_at === resetsAt)
      windows.push({ window: limit.kind, used_pct: usedPct, resets_at: resetsAt, observed_at: same?.observed_at ?? iso(nowMs) })
    }
    const next: Limits = {
      state: windows.length > 0 ? 'available' : 'unknown',
      quota_key: null,
      login_marker: null,
      windows,
    }
    if (JSON.stringify(next) !== JSON.stringify(state.limits)) {
      state.limits = next
      isChanged = true
    }
  }
  if (reading.costUsd !== undefined && Number.isFinite(reading.costUsd) && reading.costUsd >= 0 && reading.costUsd !== state.costUsd) {
    const increase = costIncrease(state, reading.costUsd)
    if (increase > 0) {
      const day = localDay(nowMs, reading.utcOffsetMinutes ?? 0)
      state.costByDay[day] = (state.costByDay[day] ?? 0) + increase
    }
    state.costUsd = reading.costUsd
    isChanged = true
  }
  if (isChanged) touch(state)
  return isChanged
}

/** Whether Soft Halo has acknowledged a bucket and it is old enough to drop. */
export function canPrune(ack: Ack | null, state: SessionState, bucket: Bucket, today: string): boolean {
  if (!ack || ack.format !== ACK_FORMAT) return false
  if (ack.app !== APP || ack.profile !== state.profile || ack.session_id !== state.sessionId) return false
  if (ack.writer_generation !== state.generation) return false
  if (state.changed.has(bucket) || bucket.modified_seq > ack.seq) return false
  return daysBetween(bucket.day, today) > PRUNE_AFTER_DAYS
}

export function parseAck(text: string | null): Ack | null {
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    const isAck =
      value?.format === ACK_FORMAT &&
      typeof value.app === 'string' &&
      typeof value.profile === 'string' &&
      typeof value.session_id === 'string' &&
      typeof value.writer_generation === 'string' &&
      Number.isInteger(value.seq)
    return isAck ? (value as Ack) : null
  } catch {
    return null
  }
}

export interface PreparedWrite {
  slot: Slot
  seq: number
  text: string
  /** Call once the write succeeded: advances seq and the slot, clears the changed set. */
  commit: () => void
}

/**
 * Builds the next version. Nothing in `state` changes until `commit()`, so a
 * failed write is retried into the same slot (the other one still holds the
 * newest valid version).
 */
export function prepareWrite(
  state: SessionState,
  args: { nowMs: number; utcOffsetMinutes: number; pluginVersion: string; appVersion?: string; ack: Ack | null },
): PreparedWrite {
  const seq = state.seq + 1
  const today = localDay(args.nowMs, args.utcOffsetMinutes)
  // What this write carries. Changes made while it is in flight stay pending for the next one.
  const revisionAtPrepare = state.revision
  const carried = new Map(state.changed)
  let buckets = state.buckets.filter(b => !canPrune(args.ack, state, b, today))
  let unackedPruned = state.unackedPruned
  // A cost day only changes while it is today, so an acknowledgment of this
  // generation covers it once it is past the same 35 days.
  const isAcked = args.ack?.format === ACK_FORMAT && args.ack.app === APP && args.ack.profile === state.profile &&
    args.ack.session_id === state.sessionId && args.ack.writer_generation === state.generation
  const costDays = Object.entries(state.costByDay)
    .filter(([day]) => !(isAcked && daysBetween(day, today) > PRUNE_AFTER_DAYS))
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([day, usd]) => ({ day, cost_usd: Math.round(usd * 1e6) / 1e6 }))

  const render = (): string => {
    const sorted = buckets
      .map(b => {
        const { incomplete, ...rest } = b
        return {
          ...rest,
          ...(incomplete && incomplete.length > 0 ? { incomplete: [...incomplete].sort() } : {}),
          modified_seq: carried.has(b) ? seq : b.modified_seq,
        }
      })
      .sort((x, y) => (x.day + x.model + x.call_kind).localeCompare(y.day + y.model + y.call_kind))
    const snapshot: Snapshot = {
      format: FORMAT,
      app: APP,
      ...(args.appVersion ? { app_version: args.appVersion } : {}),
      plugin_version: args.pluginVersion,
      profile: state.profile,
      session_id: state.sessionId,
      writer_generation: state.generation,
      seq,
      written_at: iso(args.nowMs),
      utc_offset_minutes: args.utcOffsetMinutes,
      coverage: {
        session_started_at: state.sessionStartedAt,
        collected_since: state.collectedSince,
        complete: Date.parse(state.collectedSince) <= Date.parse(state.sessionStartedAt),
      },
      ...(sorted.length > 0 ? { buckets_since: sorted[0].day } : {}),
      ...(unackedPruned ? { unacked_pruned: unackedPruned } : {}),
      ...(state.limits ? { limits: state.limits } : {}),
      ...(state.costUsd !== null ? { cost_usd: state.costUsd, cost_source: 'host' as const } : {}),
      ...(costDays.length > 0 ? { cost_by_day: costDays } : {}),
      buckets: sorted,
      recent_request_keys: state.recentKeys,
      session_ended: state.ended,
      write_complete: true,
    }
    return JSON.stringify(snapshot)
  }

  let text = render()
  // Near the reader's size limit: drop the oldest day, acknowledged or not, and
  // say so in unacked_pruned so Soft Halo shows the gap.
  while (new TextEncoder().encode(text).length > SOFT_MAX_BYTES && buckets.length > 1) {
    const oldest = buckets.reduce((min, b) => (b.day < min ? b.day : min), buckets[0].day)
    buckets = buckets.filter(b => b.day !== oldest)
    unackedPruned = { from: unackedPruned?.from ?? oldest, to: oldest }
    text = render()
  }

  const prunedCandidates = [...state.buckets]
  const costDayCandidates = Object.keys(state.costByDay)
  const slot: Slot = state.lastSlot === 'a' ? 'b' : 'a'
  return {
    slot,
    seq,
    text,
    commit: () => {
      for (const [bucket, revision] of carried) {
        bucket.modified_seq = seq
        // Changed again during the write: it stays pending, so the next write carries it with a higher seq.
        if (state.changed.get(bucket) === revision) state.changed.delete(bucket)
      }
      // Remove only what this write pruned; buckets and cost days added meanwhile stay.
      const kept = new Set(buckets)
      const pruned = new Set(prunedCandidates.filter(b => !kept.has(b)))
      state.buckets = state.buckets.filter(b => !pruned.has(b))
      const keptDays = new Set(costDays.map(c => c.day))
      for (const day of costDayCandidates) if (!keptDays.has(day)) delete state.costByDay[day]
      state.unackedPruned = unackedPruned
      state.seq = seq
      state.lastSlot = slot
      state.dirty = state.revision !== revisionAtPrepare
    },
  }
}

/** Reads one slot: the snapshot if the file is whole and belongs to this session, else 'invalid'. */
export function parseSlot(text: string | null, sessionId: string): Snapshot | 'invalid' | null {
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    const isValid =
      value?.format === FORMAT &&
      value.write_complete === true &&
      value.session_id === sessionId &&
      typeof value.writer_generation === 'string' &&
      Number.isInteger(value.seq) &&
      value.seq >= 1 &&
      Array.isArray(value.buckets)
    return isValid ? (value as Snapshot) : 'invalid'
  } catch {
    return 'invalid'
  }
}

/**
 * Restores a session from its two slots, continuing the same generation.
 * Returns null when there is nothing to restore, or when a slot is damaged:
 * the damaged one might be a newer version Soft Halo already read, so
 * continuing could reuse its seq with different content. A new generation
 * starts instead.
 */
export function restore(slots: { a: string | null; b: string | null }, sessionId: string, profile: string): SessionState | null {
  const a = parseSlot(slots.a, sessionId)
  const b = parseSlot(slots.b, sessionId)
  if (a === 'invalid' || b === 'invalid') return null
  const candidates = [
    ...(a ? [{ slot: 'a' as const, snap: a }] : []),
    ...(b ? [{ slot: 'b' as const, snap: b }] : []),
  ]
  if (candidates.length === 0) return null
  // The two slots can hold different generations after an earlier reset; the
  // newer write wins, and only it is continued.
  const newest = candidates.reduce((x, y) => {
    const isNewer =
      x.snap.writer_generation === y.snap.writer_generation
        ? y.snap.seq > x.snap.seq
        : Date.parse(y.snap.written_at) > Date.parse(x.snap.written_at)
    return isNewer ? y : x
  })
  const snap = newest.snap
  if (snap.profile !== profile) return null
  return {
    sessionId,
    profile,
    generation: snap.writer_generation,
    seq: snap.seq,
    sessionStartedAt: snap.coverage?.session_started_at ?? snap.coverage.collected_since,
    collectedSince: snap.coverage.collected_since,
    buckets: snap.buckets.map(bucket => ({ ...bucket })),
    changed: new Map(),
    revision: 0,
    recentKeys: [...(snap.recent_request_keys ?? [])],
    limits: snap.limits && snap.limits.state !== 'unavailable' ? (snap.limits as Limits) : null,
    costUsd: typeof snap.cost_usd === 'number' ? snap.cost_usd : null,
    costByDay: Object.fromEntries((snap.cost_by_day ?? []).filter(c => typeof c.cost_usd === 'number').map(c => [c.day, c.cost_usd])),
    unackedPruned: snap.unacked_pruned ?? null,
    ended: false,
    lastSlot: newest.slot,
    dirty: snap.session_ended === true,
  }
}

export interface UsageEnv {
  LOCALAPPDATA?: string
  HOME?: string
  USERPROFILE?: string
  XDG_STATE_HOME?: string
}

/** Soft Halo's usage folder on this system, or null when no home folder is known. */
export function usageRoot(env: UsageEnv, hasMacLibrary: boolean): string | null {
  const trim = (p: string) => p.replace(/[\\/]+$/, '')
  if (env.LOCALAPPDATA) return `${trim(env.LOCALAPPDATA)}/Softhalo/usage`
  const home = env.HOME || env.USERPROFILE
  if (home && hasMacLibrary) return `${trim(home)}/Library/Application Support/Softhalo/usage`
  if (env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith('/')) return `${trim(env.XDG_STATE_HOME)}/softhalo/usage`
  if (home) return `${trim(home)}/.local/state/softhalo/usage`
  return null
}

/** Windows profile folders that are never a person's. */
const NOT_A_USER = new Set(['all users', 'default', 'default user', 'public', 'desktop.ini'])

/** True inside WSL, where Soft Halo itself runs on the Windows side. */
export function isWsl(env: { WSL_DISTRO_NAME?: string; WSL_INTEROP?: string }): boolean {
  return !!(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
}

/**
 * Inside WSL: the Windows user whose `AppData\Local\Softhalo` folder exists, seen through
 * the Windows drive mount. `withSofthalo` lists the user folders under `<mount>/Users` that have
 * one. One such user is the answer; with several, the one named like the Linux user; otherwise
 * null, and nothing is written (SOFTHALO_USAGE_DIR then says where).
 */
export function wslUsageRoot(usersDir: string, withSofthalo: string[], linuxUser: string | undefined): string | null {
  const people = withSofthalo.filter(name => !NOT_A_USER.has(name.toLowerCase()))
  const pick =
    people.length === 1 ? people[0] : people.find(name => !!linuxUser && name.toLowerCase() === linuxUser.toLowerCase())
  return pick ? `${usersDir.replace(/\/+$/, '')}/${pick}/AppData/Local/Softhalo/usage` : null
}

export const slotPath = (root: string, sessionId: string, slot: Slot) => `${root}/claude/claude-${sessionId}.${slot}.json`
export const ackPath = (root: string, sessionId: string) => `${root}/ack/claude-${sessionId}.json`

/** Session ids become file names; anything that isn't a plain id is refused. */
export function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
}

/** An opaque, stable id for a Claude config folder: never the path itself. */
export async function profileId(configDir: string): Promise<string> {
  const normalized = configDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `cfg-${hex.slice(0, 20)}`
}
