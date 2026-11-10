// Soft Halo Usage: records this session's token usage and plan-limit readings
// to Soft Halo's local usage folder. No network, no commands, no UI: Soft Halo
// shows the numbers. The format and the write rules are in ./core.ts.
import type { EngineInterface, Register } from 'claude-code'
import {
  applyMeasure,
  applyStep,
  ackPath,
  isSafeSessionId,
  isWsl,
  newSession,
  parseAck,
  prepareWrite,
  profileId,
  restore,
  slotPath,
  touch,
  usageRoot,
  wslUsageRoot,
  type SessionState,
} from './core.ts'

/** WSL mounts the Windows C: drive here unless /etc/wsl.conf moves it; SOFTHALO_USAGE_DIR covers that case. */
const WSL_WINDOWS_DRIVE = '/mnt/c'

export const PLUGIN_VERSION = '1.0.0'
/** Wait this long after the last change before writing... */
export const DEBOUNCE_MS = 5_000
/** ...but never hold a change longer than this. */
export const MAX_HOLD_MS = 10_000

/** What the module keeps between events. Module variables start over on a hot reload; the slots don't. */
interface Writer {
  root: string | null | undefined
  profile: string | undefined
  current: SessionState | undefined
  loading: Promise<SessionState | undefined> | undefined
  /** One write in flight at a time, in order. */
  chain: Promise<void>
  timer: { cancel: () => void } | undefined
  pendingSince: number | undefined
}

const utcOffsetMinutes = () => -new Date().getTimezoneOffset()

async function readOrNull($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** Inside WSL, Soft Halo's folder on the Windows side, through the C: drive mount. */
async function findWslRoot($: EngineInterface, linuxUser: string | undefined): Promise<string | null> {
  const usersDir = `${WSL_WINDOWS_DRIVE}/Users`
  try {
    const entries = await $.fs.list(usersDir)
    const withSofthalo: string[] = []
    for (const entry of entries) {
      if (entry.kind !== 'dir') continue
      if (await $.fs.exists(`${usersDir}/${entry.name}/AppData/Local/Softhalo`).catch(() => false)) withSofthalo.push(entry.name)
    }
    return wslUsageRoot(usersDir, withSofthalo, linuxUser)
  } catch {
    return null
  }
}

async function setup($: EngineInterface, w: Writer): Promise<boolean> {
  if (w.root === undefined) {
    const env = {
      LOCALAPPDATA: await $.env.get('LOCALAPPDATA'),
      HOME: await $.env.get('HOME'),
      USERPROFILE: await $.env.get('USERPROFILE'),
      XDG_STATE_HOME: await $.env.get('XDG_STATE_HOME'),
    }
    const home = env.HOME ?? env.USERPROFILE
    const override = await $.env.get('SOFTHALO_USAGE_DIR')
    const wsl = isWsl({ WSL_DISTRO_NAME: await $.env.get('WSL_DISTRO_NAME'), WSL_INTEROP: await $.env.get('WSL_INTEROP') })
    if (override) {
      w.root = override.replace(/[\\/]+$/, '')
    } else if (wsl && !env.LOCALAPPDATA) {
      w.root = await findWslRoot($, await $.env.get('USER'))
    } else {
      const hasMacLibrary =
        !env.LOCALAPPDATA && !!home && (await $.fs.exists(`${home}/Library/Application Support`).catch(() => false))
      w.root = usageRoot(env, hasMacLibrary)
    }
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : 'default')
    w.profile = await profileId(configDir)
  }
  return w.root !== null
}

async function load($: EngineInterface, w: Writer, sessionId: string): Promise<SessionState | undefined> {
  if (!(await setup($, w)) || !w.root || !w.profile || !isSafeSessionId(sessionId)) return undefined
  const restored = restore(
    {
      a: await readOrNull($, slotPath(w.root, sessionId, 'a')),
      b: await readOrNull($, slotPath(w.root, sessionId, 'b')),
    },
    sessionId,
    w.profile,
  )
  if (restored) return restored
  const now = await $.clock.now()
  const usage = await $.session.usage().catch(() => undefined)
  return newSession({
    sessionId,
    profile: w.profile,
    generation: crypto.randomUUID(),
    nowMs: now,
    sessionStartedMs: Number.isFinite(usage?.startedAt) ? (usage?.startedAt as number) : now,
  })
}

/** The state of the session that is current now, switching (and flushing the old one) when it changed. */
async function currentSession($: EngineInterface, w: Writer): Promise<SessionState | undefined> {
  const sessionId = await $.session.id()
  if (w.current?.sessionId === sessionId) return w.current
  if (w.loading) {
    const loaded = await w.loading
    if (loaded?.sessionId === sessionId) return loaded
  }
  if (w.current) void flush($, w, w.current)
  w.loading = load($, w, sessionId)
  w.current = await w.loading
  w.loading = undefined
  return w.current
}

function flush($: EngineInterface, w: Writer, state: SessionState): Promise<void> {
  w.chain = w.chain
    .then(async () => {
      if (!state.dirty || !w.root) return
      const ack = parseAck(await readOrNull($, ackPath(w.root, state.sessionId)))
      const write = prepareWrite(state, {
        nowMs: await $.clock.now(),
        utcOffsetMinutes: utcOffsetMinutes(),
        pluginVersion: PLUGIN_VERSION,
        ack,
      })
      await $.fs.write(slotPath(w.root, state.sessionId, write.slot), write.text)
      write.commit()
    })
    .catch(() => {
      // A failed write leaves the state as it was: the next one retries into
      // the same slot, and the other slot still holds the newest version.
    })
  return w.chain
}

async function schedule($: EngineInterface, w: Writer, state: SessionState) {
  const now = await $.clock.now()
  w.pendingSince ??= now
  w.timer?.cancel()
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, w.pendingSince + MAX_HOLD_MS - now))
  w.timer = $.clock.after(wait, () => {
    w.timer = undefined
    w.pendingSince = undefined
    void flush($, w, state)
  })
}

async function recordStep(
  $: EngineInterface,
  w: Writer,
  step: { turnId: string; index: number; agentId?: string; model: string },
  usage: {
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  } | null,
) {
  const state = await currentSession($, w)
  if (!state) return
  const isNew = applyStep(state, {
    key: `${step.turnId}:${step.index}:${step.agentId ?? ''}`,
    requestedModel: step.model,
    agentId: step.agentId,
    usage: usage
      ? {
          model: usage.model,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        }
      : null,
    finishedAtMs: await $.clock.now(),
    utcOffsetMinutes: utcOffsetMinutes(),
  })
  if (isNew) await schedule($, w, state)
}

async function recordMeasure(
  $: EngineInterface,
  w: Writer,
  reading: { rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]; costUsd?: number },
) {
  const state = await currentSession($, w)
  if (state && applyMeasure(state, { ...reading, utcOffsetMinutes: utcOffsetMinutes() }, await $.clock.now())) {
    await schedule($, w, state)
  }
}

async function endSession($: EngineInterface, w: Writer, sessionId: string) {
  const state = w.current
  if (state?.sessionId !== sessionId) return
  w.timer?.cancel()
  w.timer = undefined
  w.pendingSince = undefined
  state.ended = true
  touch(state)
  await flush($, w, state)
}

export const register: Register = on => {
  const w: Writer = {
    root: undefined,
    profile: undefined,
    current: undefined,
    loading: undefined,
    chain: Promise.resolve(),
    timer: undefined,
    pendingSince: undefined,
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await currentSession($, w).catch(() => undefined)
    return result
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    // Recording usage must never disturb the session.
    if (result) await recordStep($, w, e, result.usage ?? null).catch(() => undefined)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      await recordMeasure($, w, { rateLimits: e.rateLimits, costUsd: e.cost?.usd }).catch(() => undefined)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    await endSession($, w, e.sessionId).catch(() => undefined)
    return next(e)
  })
}
