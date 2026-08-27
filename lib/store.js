/**
 * Durable cron job table for @dsh/cron.
 *
 * Jobs live in one JSON file (`<root>/jobs.json`) written atomically
 * (tmp + fsync + rename) so a crash never leaves a torn table. Structural
 * corruption of the file fails the store loudly (the plugin logs and keeps
 * running without scheduling); individual invalid jobs are dropped with a
 * warning so one bad row cannot block the whole scheduler.
 */

import { closeSync, fdatasyncSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseExpression, canonicalizeTimezone } from './cron.js'

const STORE_VERSION = 1
export const MAX_RUN_HISTORY = 20

/** Error from an unreadable/corrupt store file. */
export class CronStoreError extends Error {
  code = 'corrupt_cron_store'
  constructor(message, options) {
    super(message, options)
    this.name = 'CronStoreError'
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new CronStoreError(`${label} must be a non-empty string`)
  return value
}

function requireInstant(value, label) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) throw new CronStoreError(`${label} must be a canonical UTC instant or null`)
  return value
}

function requireEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new CronStoreError(`${label} must be one of ${allowed.join(', ')}`)
  return value
}

/**
 * Validate one job record's shape (not its scheduling semantics).
 * @param {unknown} value
 * @returns {import('./types.js').CronJob}
 */
export function validateJob(value) {
  if (!isRecord(value)) throw new CronStoreError('job must be an object')
  const id = requireString(value.id, 'job.id')
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new CronStoreError('job.id must be a safe identifier')
  const prompt = requireString(value.prompt, 'job.prompt')
  const title = typeof value.title === 'string' && value.title.length > 0 ? value.title : 'untitled'
  const schedule = value.schedule
  if (!isRecord(schedule)) throw new CronStoreError('job.schedule must be an object')
  const expression = requireString(schedule.expression, 'job.schedule.expression')
  const timezone = requireString(schedule.timezone, 'job.schedule.timezone')
  const target = value.target
  if (!isRecord(target)) throw new CronStoreError('job.target must be an object')
  const kind = requireEnum(target.kind, ['new-chat', 'existing-chat'], 'job.target.kind')
  if (kind === 'existing-chat' && (typeof target.sessionId !== 'string' || target.sessionId.length === 0)) {
    throw new CronStoreError('job.target.sessionId is required for existing-chat targets')
  }
  const notification = isRecord(value.notification)
    ? { mode: requireEnum(value.notification.mode, ['session'], 'job.notification.mode') }
    : { mode: 'session' }
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : true
  const runHistory = Array.isArray(value.runHistory) ? value.runHistory.slice(0, MAX_RUN_HISTORY).map((entry) => {
    if (!isRecord(entry)) throw new CronStoreError('job.runHistory entries must be objects')
    const runAt = requireInstant(entry.runAt, 'runHistory.runAt')
    const status = requireEnum(entry.status, ['ok', 'failed', 'skipped'], 'runHistory.status')
    return {
      runAt,
      status,
      ...typeof entry.sessionId === 'string' && entry.sessionId.length > 0 ? { sessionId: entry.sessionId } : {},
      ...typeof entry.error === 'string' && entry.error.length > 0 ? { error: entry.error.slice(0, 2000) } : {},
    }
  }) : []
  return {
    id,
    title,
    prompt,
    schedule: { expression, timezone },
    target: {
      kind,
      ...kind === 'existing-chat' ? { sessionId: target.sessionId } : {},
      ...typeof target.project === 'string' && target.project.length > 0 ? { project: target.project } : {},
      ...typeof target.provider === 'string' && target.provider.length > 0 ? { provider: target.provider } : {},
      ...typeof target.model === 'string' && target.model.length > 0 ? { model: target.model } : {},
      ...typeof target.reasoningEffort === 'string' && target.reasoningEffort.length > 0 ? { reasoningEffort: target.reasoningEffort } : {},
    },
    notification,
    enabled,
    nextRunAt: requireInstant(value.nextRunAt, 'job.nextRunAt'),
    lastRunAt: requireInstant(value.lastRunAt, 'job.lastRunAt'),
    runHistory,
    createdAt: requireInstant(value.createdAt, 'job.createdAt'),
    updatedAt: requireInstant(value.updatedAt, 'job.updatedAt'),
  }
}

/**
 * Disk-backed job table. All mutations are synchronous and persisted through
 * {@link save}; the runtime and tools are the only writers and they serialize
 * through the runtime's per-job transaction tails.
 */
export class CronStore {
  #ctx
  #root
  #file
  #jobs = new Map()
  #nextId = 1

  constructor(ctx, root) {
    this.#ctx = ctx
    this.#root = root
    this.#file = join(root, 'jobs.json')
  }

  get file() {
    return this.#file
  }

  /** Read and validate the table. Throws {@link CronStoreError} on file corruption. */
  load() {
    if (!existsSync(this.#file)) {
      this.#jobs = new Map()
      this.#nextId = 1
      return
    }
    let payload
    try {
      payload = JSON.parse(readFileSync(this.#file, 'utf8'))
    } catch (error) {
      throw new CronStoreError(`failed to read cron store ${this.#file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    if (!isRecord(payload) || payload.version !== STORE_VERSION || !Array.isArray(payload.jobs)) {
      throw new CronStoreError(`cron store ${this.#file} has an unsupported shape (expected version ${STORE_VERSION} with a jobs array)`)
    }
    const jobs = new Map()
    let maxSequence = 0
    for (const raw of payload.jobs) {
      try {
        const job = validateJob(raw)
        jobs.set(job.id, job)
        const sequence = Number(/^cron-(\d+)$/.exec(job.id)?.[1] ?? 0)
        if (Number.isSafeInteger(sequence) && sequence > maxSequence) maxSequence = sequence
      } catch (error) {
        this.#ctx.logger.warn(`cron: dropping invalid job record: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const nextId = Number.isSafeInteger(payload.nextId) && payload.nextId > maxSequence ? payload.nextId : maxSequence + 1
    this.#jobs = jobs
    this.#nextId = nextId
  }

  /** Persist the current table atomically. */
  save() {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 })
    const temporary = `${this.#file}.tmp-${process.pid}-${Date.now()}`
    const payload = JSON.stringify({ version: STORE_VERSION, nextId: this.#nextId, jobs: [...this.#jobs.values()] }, null, 2)
    let fd
    try {
      fd = openSync(temporary, 'w', 0o600)
      writeFileSync(fd, `${payload}\n`)
      fdatasyncSync(fd)
    } catch (error) {
      throw new CronStoreError(`failed to write cron store ${temporary}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    try {
      renameSync(temporary, this.#file)
    } catch (error) {
      throw new CronStoreError(`failed to commit cron store ${this.#file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  list() {
    return [...this.#jobs.values()]
  }

  get(id) {
    return this.#jobs.get(id)
  }

  /** Allocate the next monotonically increasing job id (`cron-N`). */
  allocateId() {
    const id = `cron-${this.#nextId}`
    this.#nextId += 1
    return id
  }

  /** Insert or replace one job by id. */
  upsert(job) {
    this.#jobs.set(job.id, validateJob(job))
  }

  remove(id) {
    return this.#jobs.delete(id)
  }

  get size() {
    return this.#jobs.size
  }
}

/** Validate scheduling semantics at create/update time (expression + timezone). */
export function assertScheduleValid(expression, timezone) {
  parseExpression(expression)
  canonicalizeTimezone(timezone)
}
