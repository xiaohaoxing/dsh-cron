/**
 * Pure cron engine for @dsh/cron.
 *
 * Supports standard 5-field expressions:  minute hour day-of-month month day-of-week
 *   - `*` wildcard, step `* / n`, `a-b` range, `a-b/n`, `a,b,c` lists
 *   - `?` alias for `*` (allowed in day-of-month / day-of-week only)
 *   - month names JAN..DEC and day-of-week names SUN..SAT (also 0 and 7 = Sunday)
 *   - Vixie-cron day rule: when BOTH dom and dow are restricted, the day matches
 *     if EITHER matches; when one is a wildcard the other decides.
 *
 * Timezone aware: wall-clock fields are read in the target IANA zone through
 * `Intl.DateTimeFormat`; DST gaps/overlaps are resolved by offset probing
 * (same approach as `@deepseek-ai/dsh-schedule`).
 *
 * Zero runtime dependencies so the engine can be unit-tested standalone.
 */

const MONTH_NAMES = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}

const DOW_NAMES = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
}

/** Fixed per-field bounds. */
const FIELDS = {
  minute: { min: 0, max: 59, names: null, allowQuestion: false },
  hour: { min: 0, max: 23, names: null, allowQuestion: false },
  dom: { min: 1, max: 31, names: null, allowQuestion: true },
  month: { min: 1, max: 12, names: MONTH_NAMES, allowQuestion: false },
  dow: { min: 0, max: 7, names: DOW_NAMES, allowQuestion: true },
}

const FIELD_ORDER = ['minute', 'hour', 'dom', 'month', 'dow']

const MIN_YEAR_MS = Date.parse('0001-01-01T00:00:00.000Z')
const MAX_YEAR_MS = Date.parse('9999-12-31T23:59:59.999Z')

/** Error from a malformed cron expression or timezone. */
export class CronExpressionError extends Error {
  constructor(message, code = 'invalid_expression') {
    super(message)
    this.name = 'CronExpressionError'
    this.code = code
  }
}

/**
 * Normalize one IANA time-zone selector, returning the canonical zone name.
 * @param {string} value - `UTC` or an IANA Area/Location name.
 * @returns {string} canonical zone.
 * @throws {CronExpressionError} for unknown or malformed zones.
 */
export function canonicalizeTimezone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new CronExpressionError('timezone must be a non-empty string without surrounding whitespace.', 'invalid_time_zone')
  }
  if (value !== 'UTC' && !/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/.test(value)) {
    throw new CronExpressionError('timezone must be UTC or a valid IANA Area/Location name.', 'invalid_time_zone')
  }
  let canonical
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    throw new CronExpressionError(`unknown timezone "${value}".`, 'invalid_time_zone')
  }
  return canonical
}

function fieldNumber(text, names, min, max, label) {
  const upper = text.toUpperCase()
  if (names !== null && upper in names) {
    const named = names[upper]
    if (named < min || named > max) throw new CronExpressionError(`invalid ${label} name "${text}".`)
    return named
  }
  if (!/^\d+$/.test(text)) throw new CronExpressionError(`invalid ${label} value "${text}".`)
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CronExpressionError(`${label} value ${text} is out of range ${min}-${max}.`)
  }
  return value
}

/**
 * Parse one field into a matcher: `null` for wildcard, else `{ values: Set<number> }`.
 * @param {string} text - raw field text.
 * @param {keyof typeof FIELDS} key - field name.
 * @returns {{ values: Set<number> } | null}
 */
export function parseField(text, key) {
  const spec = FIELDS[key]
  const label = key
  const raw = String(text).trim()
  if (raw === '*') return null
  if (raw === '?' && spec.allowQuestion) return null
  const values = new Set()
  const normalizeDow = key === 'dow' ? (v) => (v === 7 ? 0 : v) : (v) => v
  for (const item of raw.split(',')) {
    const trimmed = item.trim()
    if (trimmed === '') throw new CronExpressionError(`empty ${label} list item in "${text}".`)
    const match = /^([A-Za-z]+|\d+|\*)(?:-([A-Za-z]+|\d+|\*))?(?:\/(\d+))?$/.exec(trimmed)
    if (match === null) throw new CronExpressionError(`invalid ${label} item "${trimmed}".`)
    const [, fromText, toText, stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isSafeInteger(step) || step <= 0) throw new CronExpressionError(`${label} step must be a positive integer.`)
    let from
    let to
    if (fromText === '*') {
      from = spec.min
      to = toText === undefined ? spec.max : fieldNumber(toText, spec.names, spec.min, spec.max, label)
    } else {
      from = fieldNumber(fromText, spec.names, spec.min, spec.max, label)
      to = toText === undefined ? from : toText === '*' ? spec.max : fieldNumber(toText, spec.names, spec.min, spec.max, label)
    }
    if (to < from) throw new CronExpressionError(`${label} range ${from}-${to} is inverted.`)
    for (let v = from; v <= to; v += step) values.add(normalizeDow(v))
  }
  return values.size === 0 ? null : { values }
}

/**
 * Parse a full 5-field expression into a matcher object.
 * @param {string} expression - e.g. `0 9 * * *`.
 * @returns {Record<'minute'|'hour'|'dom'|'month'|'dow', { values: Set<number> } | null>}
 * @throws {CronExpressionError}
 */
export function parseExpression(expression) {
  if (typeof expression !== 'string') throw new CronExpressionError('expression must be a string.')
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronExpressionError(`expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}.`)
  }
  const matcher = {}
  for (let index = 0; index < FIELD_ORDER.length; index += 1) {
    matcher[FIELD_ORDER[index]] = parseField(parts[index], FIELD_ORDER[index])
  }
  return matcher
}

/** Whether a wildcard-or-matcher accepts `value`. */
function matches(field, value) {
  return field === null || field.values.has(value)
}

/** Vixie day rule: dom/dow both restricted → OR; otherwise the non-wildcard decides. */
function dayMatches(spec, day, weekday) {
  const domRestricted = spec.dom !== null
  const dowRestricted = spec.dow !== null
  if (!domRestricted && !dowRestricted) return true
  if (domRestricted && dowRestricted) return spec.dom.values.has(day) || spec.dow.values.has(weekday)
  return domRestricted ? spec.dom.values.has(day) : spec.dow.values.has(weekday)
}

/**
 * Build a wall-clock reader for one canonical zone.
 * The returned function carries `.zone` for DST-gap fallbacks.
 * @param {string} timeZone - canonical IANA zone.
 * @returns {(epochMs: number) => { year: number; month: number; day: number; hour: number; minute: number; weekday: number }}
 */
export function zonedReader(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  })
  const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const reader = (epochMs) => {
    const parts = Object.fromEntries(formatter.formatToParts(epochMs).map((part) => [part.type, part.value]))
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      weekday: weekdayIndex[parts.weekday] ?? -1,
    }
  }
  reader.zone = timeZone
  return reader
}

/** Interpret calendar parts as a UTC-shaped epoch without normalization surprises. */
function calendarEpoch(parts) {
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  value.setUTCHours(parts.hour, parts.minute, 0, 0)
  return value.getTime()
}

function sameWallTime(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute
}

/**
 * Resolve a wall-clock `{year, month, day, hour, minute}` in one zone to an
 * instant, choosing the FIRST instant in a DST overlap and returning `null`
 * for a nonexistent wall time (DST gap). Callers walk forward on `null`.
 * @param {{ year: number; month: number; day: number; hour: number; minute: number }} parts
 * @param {string} timeZone - canonical IANA zone.
 * @returns {number | null}
 */
export function resolveZonedInstant(parts, timeZone) {
  const reader = zonedReader(timeZone)
  const localEpoch = calendarEpoch(parts)
  const offsets = new Set()
  for (const delta of [-1728e5, -864e5, 0, 864e5, 1728e5]) {
    const sample = Math.min(MAX_YEAR_MS, Math.max(MIN_YEAR_MS, localEpoch + delta))
    const projected = reader(sample)
    const offsetMinutes = Math.round((calendarEpoch(projected) - sample) / 60000)
    offsets.add(offsetMinutes)
  }
  const candidates = []
  for (const offset of offsets) {
    const candidate = localEpoch - offset * 60000
    if (candidate < MIN_YEAR_MS || candidate > MAX_YEAR_MS) continue
    if (sameWallTime(reader(candidate), parts)) candidates.push(candidate)
  }
  candidates.sort((left, right) => left - right)
  return candidates.length === 0 ? null : candidates[0]
}

/**
 * Compute the next occurrence strictly after `fromMs` for an expression in one zone.
 * @param {string} expression - 5-field cron expression.
 * @param {string} timeZone - IANA zone.
 * @param {number} fromMs - epoch milliseconds; the result is strictly after this.
 * @param {{ horizonMs?: number }} [options]
 * @returns {number | null} epoch milliseconds of the next occurrence, or `null`
 *   when none exists within the horizon (e.g. Feb 30).
 * @throws {CronExpressionError} on malformed expression/zone.
 */
export function nextOccurrence(expression, timeZone, fromMs, options = {}) {
  const spec = parseExpression(expression)
  const zone = canonicalizeTimezone(timeZone)
  const horizonMs = options.horizonMs ?? 5 * 366 * 24 * 3600 * 1000
  if (!Number.isSafeInteger(fromMs) || fromMs < MIN_YEAR_MS || fromMs > MAX_YEAR_MS) {
    throw new CronExpressionError('fromMs must be a representable instant.')
  }
  const reader = zonedReader(zone)
  const limit = Math.min(fromMs + horizonMs, MAX_YEAR_MS)
  let instant = Math.floor(fromMs / 60000) * 60000 + 60000
  let guard = 0
  while (instant <= limit && guard < 500000) {
    guard += 1
    const fields = reader(instant)
    if (!matches(spec.month, fields.month)) {
      const next = advanceMonth(fields, reader, instant)
      if (next === null) break
      instant = next
      continue
    }
    if (!dayMatches(spec, fields.day, fields.weekday)) {
      const next = advanceDay(fields, reader, instant)
      if (next === null) break
      instant = next
      continue
    }
    if (!matches(spec.hour, fields.hour)) {
      const next = advanceHour(fields, reader, instant)
      if (next === null) break
      instant = next
      continue
    }
    if (!matches(spec.minute, fields.minute)) {
      instant += 60000
      continue
    }
    return instant
  }
  return null
}

/** Try `target` wall time in `reader.zone`; on a DST gap, walk forward from `fromInstant` until `stillBefore` clears. */
function advanceOrWalk(reader, target, fromInstant, stillBefore) {
  const instant = resolveZonedInstant(target, reader.zone)
  if (instant !== null) return instant
  let cursor = fromInstant + 60000
  const cap = cursor + 24 * 3600 * 1000
  let guard = 0
  while (cursor < cap && guard < 2000) {
    guard += 1
    const f = reader(cursor)
    if (!stillBefore(f)) return cursor
    cursor += 60000
  }
  return null
}

/** First instant of the month after `fields`' month, or `null` if unresolvable. */
function advanceMonth(fields, reader, fromInstant) {
  const year = fields.month === 12 ? fields.year + 1 : fields.year
  const month = fields.month === 12 ? 1 : fields.month + 1
  return advanceOrWalk(reader, { year, month, day: 1, hour: 0, minute: 0 }, fromInstant, (f) => f.month === fields.month && f.year === fields.year)
}

/** First instant of the day after `fields`' day, or `null` if unresolvable. */
function advanceDay(fields, reader, fromInstant) {
  const next = new Date(0)
  next.setUTCFullYear(fields.year, fields.month - 1, fields.day + 1)
  const target = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 }
  return advanceOrWalk(reader, target, fromInstant, (f) => f.day === fields.day && f.month === fields.month && f.year === fields.year)
}

/** First instant of the hour after `fields`' hour, or `null` if unresolvable. */
function advanceHour(fields, reader, fromInstant) {
  const normalized = new Date(0)
  normalized.setUTCFullYear(fields.year, fields.month - 1, fields.day)
  normalized.setUTCHours(fields.hour + 1, 0, 0, 0)
  const target = { year: normalized.getUTCFullYear(), month: normalized.getUTCMonth() + 1, day: normalized.getUTCDate(), hour: normalized.getUTCHours(), minute: 0 }
  return advanceOrWalk(reader, target, fromInstant, (f) => f.hour === fields.hour && f.day === fields.day && f.month === fields.month && f.year === fields.year)
}

/**
 * Human-readable label for an expression (sidebar badge / default task title).
 * @param {string} expression
 * @returns {string}
 */
export function describe(expression) {
  const spec = parseExpression(expression)
  const at = describeTime(spec)
  if (at !== null) {
    if (spec.dom === null && spec.month === null && spec.dow === null) return `daily at ${at}`
    if (spec.dow !== null && spec.dom === null && spec.month === null) {
      const days = compressRanges([...spec.dow.values], (v) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][v])
      return `${days} at ${at}`
    }
    if (spec.dom !== null && spec.dow === null && spec.month === null) {
      return `monthly on day ${compressRanges([...spec.dom.values], (v) => String(v))} at ${at}`
    }
  }
  if (spec.hour === null && spec.minute !== null) {
    const minutes = [...spec.minute.values].sort((left, right) => left - right)
    if (minutes.length >= 2 && minutes[0] === 0) {
      const step = minutes[1] - minutes[0]
      if (step > 0 && minutes.every((value, index) => value === index * step)) {
        return `every ${step} minutes`
      }
    }
  }
  return expression
}

function describeTime(spec) {
  if (spec.hour === null) return null
  const hours = [...spec.hour.values]
  const minutes = spec.minute === null ? [0] : [...spec.minute.values]
  if (hours.length === 1 && minutes.length === 1) {
    return `${String(hours[0]).padStart(2, '0')}:${String(minutes[0]).padStart(2, '0')}`
  }
  return null
}

/** Compress consecutive sorted numbers into `a-b` runs for compact labels. */
function compressRanges(values, format) {
  const sorted = [...values].sort((left, right) => left - right)
  const parts = []
  let start = sorted[0]
  let prev = sorted[0]
  const flush = () => {
    parts.push(start === prev ? format(start) : `${format(start)}-${format(prev)}`)
  }
  for (const value of sorted.slice(1)) {
    if (value === prev + 1) {
      prev = value
      continue
    }
    flush()
    start = prev = value
  }
  flush()
  return parts.join(', ')
}
