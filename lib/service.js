/**
 * Shared mutation core for @dsh/cron.
 *
 * One validation + persistence code path used by both the model-facing tools
 * (`tools.js`) and the browser REST API (`api.js`). Every function is
 * transport-agnostic: it returns `{ ok: true, ... }` or
 * `{ ok: false, error }` where `error` is a closed-union object
 * (`{ code, message, ... }`). Callers decide how to surface the result
 * (tool output shape vs HTTP status).
 *
 * Closed-union error codes (same as the tools): invalid_expression,
 * invalid_time_zone, invalid_target, invalid_prompt, invalid_id, not_found,
 * persistence_uncertain, internal_error.
 */

import { describe, nextOccurrence } from './cron.js'
import { SANDBOX_MODES, assertScheduleValid } from './store.js'

/** Logger duck-typed on the cordis logger (warn only; absent logger is a no-op). */
const NOOP_LOGGER = { warn: () => {} }

export function nowIso(epoch = Date.now()) {
  return new Date(epoch).toISOString()
}

/** Build the model-facing view (snake-free, camelCase like schedule tools). */
export function jobView(job, now) {
  const state = !job.enabled ? 'disabled' : job.nextRunAt !== null && Date.parse(job.nextRunAt) <= now ? 'overdue' : 'scheduled'
  return {
    ...job,
    state,
    runHistory: job.runHistory.slice(0, 5),
  }
}

/** Views for every job in creation order. */
export function listViews(runtime) {
  const now = Date.now()
  return runtime.store().list().map((job) => jobView(job, now))
}

/** Validate a job id argument, returning an error object or null. */
export function validateId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
    return { code: 'invalid_id', message: 'id must be non-empty without surrounding whitespace.' }
  }
  return null
}

/** Validate a `schedule` argument shape, returning an error object or null. */
export function validateSchedule(schedule, fallbackTimezone) {
  if (schedule === undefined) return null
  const expression = schedule.expression
  if (typeof expression !== 'string' || expression.length === 0) {
    return { code: 'invalid_expression', message: 'schedule.expression must be a non-empty 5-field cron string.' }
  }
  const timezone = schedule.timezone ?? fallbackTimezone
  try {
    assertScheduleValid(expression, timezone)
  } catch (error) {
    return { code: error instanceof Error && error.code === 'invalid_time_zone' ? 'invalid_time_zone' : 'invalid_expression', message: error instanceof Error ? error.message : String(error) }
  }
  const next = nextOccurrence(expression, timezone, Date.now())
  if (next === null) {
    return { code: 'invalid_expression', message: 'The expression has no future occurrence (e.g. Feb 30); refusing to create the job.' }
  }
  return null
}

/** Validate a `target` argument shape, returning an error object or null. */
export function validateTarget(target) {
  if (target === undefined) return null
  const kind = target.kind ?? 'new-chat'
  if (kind !== 'new-chat' && kind !== 'existing-chat') {
    return { code: 'invalid_target', message: 'target.kind must be new-chat or existing-chat.' }
  }
  if (kind === 'existing-chat' && (typeof target.sessionId !== 'string' || target.sessionId.length === 0)) {
    return { code: 'invalid_target', message: 'target.sessionId is required for existing-chat targets.' }
  }
  if (target.project !== undefined && (typeof target.project !== 'string' || target.project.length === 0)) {
    return { code: 'invalid_target', message: 'target.project must be a non-empty absolute path string.' }
  }
  if (target.reasoningEffort !== undefined && !['off', 'high', 'max'].includes(target.reasoningEffort)) {
    return { code: 'invalid_target', message: 'target.reasoningEffort must be off, high, or max.' }
  }
  // null is the explicit "clear" marker: it removes the pin so the run
  // inherits the deployment default (undefined/omitted means "keep" on merge).
  if (target.permissionMode != null && !SANDBOX_MODES.includes(target.permissionMode)) {
    return { code: 'invalid_target', message: 'target.permissionMode must be one of read-only, workspace-write, danger-full-access.' }
  }
  return null
}

function persistenceError(operation, id) {
  return {
    code: 'persistence_uncertain',
    message: 'Cron store persistence is uncertain; retry the operation before relying on this result.',
    operation,
    ...id === undefined ? {} : { id },
  }
}

/** Persist the store; returns null on success or a persistence error object. */
function persist(runtime, logger, operation, id) {
  try {
    runtime.store().save()
    return null
  } catch (error) {
    logger.warn(`cron: save failed: ${error instanceof Error ? error.message : String(error)}`)
    return persistenceError(operation, id)
  }
}

/** Merge a target argument into a full target record (create path). */
function buildTarget(input, fallbackKind = 'new-chat') {
  if (input === undefined) return { kind: fallbackKind }
  const kind = input.kind ?? fallbackKind
  return {
    kind,
    ...kind === 'existing-chat' ? { sessionId: input.sessionId } : {},
    ...input.project !== undefined ? { project: input.project } : {},
    ...input.provider !== undefined ? { provider: input.provider } : {},
    ...input.model !== undefined ? { model: input.model } : {},
    ...input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {},
    ...input.permissionMode != null ? { permissionMode: input.permissionMode } : {},
  }
}

/** Merge a target patch into the current target record (update path). */
function mergeTarget(input, current) {
  if (input === undefined) return current
  const kind = input.kind ?? current.kind
  return {
    kind,
    // A sessionId only ever belongs to existing-chat targets; switching to
    // new-chat must drop it (otherwise a stale sessionId lingers on the
    // record and misleads consumers, even though the runtime ignores it).
    ...kind === 'existing-chat' ? { sessionId: input.sessionId ?? current.sessionId } : {},
    ...input.project !== undefined ? { project: input.project } : current.project !== undefined ? { project: current.project } : {},
    ...input.provider !== undefined ? { provider: input.provider } : current.provider !== undefined ? { provider: current.provider } : {},
    ...input.model !== undefined ? { model: input.model } : current.model !== undefined ? { model: current.model } : {},
    ...input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {},
    // null explicitly clears the pin (inherit the deployment default again);
    // undefined keeps the current mode so partial patches never drop it.
    ...input.permissionMode === null ? {} : input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : current.permissionMode !== undefined ? { permissionMode: current.permissionMode } : {},
  }
}

/**
 * Create one cron job.
 * @param {import('./runtime.js').CronRuntime} runtime
 * @param {{ timezone?: string }} defaults - plugin defaults (timezone).
 * @param {{ prompt: string, title?: string, schedule: { expression: string, timezone?: string }, target?: object, notification?: object }} input
 * @param {{ warn: (msg: string) => void }} [logger]
 * @returns {{ ok: true, view: object } | { ok: false, error: object }}
 */
export function createJob(runtime, defaults, input, logger = NOOP_LOGGER) {
  const fallbackTimezone = defaults.timezone ?? runtime.defaultTimezone
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (prompt.length === 0) return { ok: false, error: { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' } }
  const scheduleError = validateSchedule(input.schedule, fallbackTimezone)
  if (scheduleError !== null) return { ok: false, error: scheduleError }
  const targetError = validateTarget(input.target)
  if (targetError !== null) return { ok: false, error: targetError }
  const timezone = input.schedule.timezone ?? fallbackTimezone
  const target = buildTarget(input.target)
  const id = runtime.store().allocateId()
  const now = nowIso()
  const nextEpoch = nextOccurrence(input.schedule.expression, timezone, Date.now())
  const job = {
    id,
    title: typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim() : describe(input.schedule.expression),
    prompt,
    schedule: { expression: input.schedule.expression, timezone },
    target,
    notification: { mode: 'session' },
    enabled: true,
    nextRunAt: nextEpoch === null ? null : nowIso(nextEpoch),
    lastRunAt: null,
    runHistory: [],
    createdAt: now,
    updatedAt: now,
  }
  try {
    runtime.store().upsert(job)
  } catch (error) {
    logger.warn(`cron: invalid job rejected: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: { code: 'internal_error', message: 'The cron operation failed.' } }
  }
  const persisted = persist(runtime, logger, 'create', id)
  if (persisted !== null) return { ok: false, error: persisted }
  return { ok: true, view: jobView(job, Date.now()) }
}

/**
 * Update one cron job by id. Any supplied field replaces that part of the job.
 * @returns {{ ok: true, view: object } | { ok: false, error: object }}
 */
export function updateJob(runtime, id, patch, logger = NOOP_LOGGER) {
  const idError = validateId(id)
  if (idError !== null) return { ok: false, error: idError }
  const current = runtime.store().get(id)
  if (current === undefined) return { ok: false, error: { code: 'not_found', message: `cron job "${id}" does not exist.` } }
  if (patch.prompt !== undefined) {
    const prompt = String(patch.prompt).trim()
    if (prompt.length === 0) return { ok: false, error: { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' } }
  }
  const scheduleError = validateSchedule(patch.schedule, current.schedule.timezone)
  if (scheduleError !== null) return { ok: false, error: scheduleError }
  const targetError = validateTarget(patch.target)
  if (targetError !== null) return { ok: false, error: targetError }
  const now = Date.now()
  const schedule = patch.schedule !== undefined
    ? { expression: patch.schedule.expression, timezone: patch.schedule.timezone ?? current.schedule.timezone }
    : current.schedule
  const target = mergeTarget(patch.target, current.target)
  const enabled = patch.enabled ?? current.enabled
  const scheduleChanged = patch.schedule !== undefined
  const wasOverdue = current.nextRunAt !== null && Date.parse(current.nextRunAt) <= now
  const recompute = scheduleChanged || (enabled && !current.enabled) || (enabled && wasOverdue)
  let nextRunAt = current.nextRunAt
  if (recompute) {
    const next = nextOccurrence(schedule.expression, schedule.timezone, now)
    nextRunAt = next === null ? null : nowIso(next)
  }
  const updated = {
    ...current,
    ...patch.title !== undefined && typeof patch.title === 'string' ? { title: patch.title.trim() || current.title } : {},
    ...patch.prompt !== undefined ? { prompt: String(patch.prompt).trim() } : {},
    schedule,
    target,
    notification: patch.notification !== undefined ? { mode: 'session' } : current.notification,
    enabled,
    nextRunAt,
    updatedAt: nowIso(now),
  }
  try {
    runtime.store().upsert(updated)
  } catch (error) {
    logger.warn(`cron: invalid job rejected: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: { code: 'internal_error', message: 'The cron operation failed.' } }
  }
  const persisted = persist(runtime, logger, 'update', updated.id)
  if (persisted !== null) return { ok: false, error: persisted }
  return { ok: true, view: jobView(updated, now) }
}

/**
 * Delete one cron job by id.
 * @returns {{ ok: true, result: { id: string, deleted: boolean } } | { ok: false, error: object }}
 */
export function deleteJob(runtime, id, logger = NOOP_LOGGER) {
  const idError = validateId(id)
  if (idError !== null) return { ok: false, error: idError }
  if (!runtime.store().remove(id)) {
    return { ok: true, result: { id, deleted: false, code: 'not_found' } }
  }
  const persisted = persist(runtime, logger, 'delete', id)
  if (persisted !== null) return { ok: false, error: persisted }
  return { ok: true, result: { id, deleted: true } }
}

/** Pause one cron job (enabled=false). @returns {{ ok: true, view } | { ok: false, error }} */
export function pauseJob(runtime, id, logger = NOOP_LOGGER) {
  const idError = validateId(id)
  if (idError !== null) return { ok: false, error: idError }
  const current = runtime.store().get(id)
  if (current === undefined) return { ok: false, error: { code: 'not_found', message: `cron job "${id}" does not exist.` } }
  const updated = { ...current, enabled: false, updatedAt: nowIso() }
  runtime.store().upsert(updated)
  const persisted = persist(runtime, logger, 'pause', updated.id)
  if (persisted !== null) return { ok: false, error: persisted }
  return { ok: true, view: jobView(updated, Date.now()) }
}

/** Resume one paused cron job; an overdue job recomputes nextRunAt from now. */
export function resumeJob(runtime, id, logger = NOOP_LOGGER) {
  const idError = validateId(id)
  if (idError !== null) return { ok: false, error: idError }
  const current = runtime.store().get(id)
  if (current === undefined) return { ok: false, error: { code: 'not_found', message: `cron job "${id}" does not exist.` } }
  const now = Date.now()
  const wasOverdue = current.nextRunAt !== null && Date.parse(current.nextRunAt) <= now
  const nextRunAt = wasOverdue
    ? (() => { const next = nextOccurrence(current.schedule.expression, current.schedule.timezone, now); return next === null ? null : nowIso(next) })()
    : current.nextRunAt
  const updated = { ...current, enabled: true, nextRunAt, updatedAt: nowIso(now) }
  runtime.store().upsert(updated)
  const persisted = persist(runtime, logger, 'resume', updated.id)
  if (persisted !== null) return { ok: false, error: persisted }
  return { ok: true, view: jobView(updated, now) }
}
