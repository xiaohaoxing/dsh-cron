import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextOccurrence,
  parseExpression,
  parseField,
  canonicalizeTimezone,
  describe,
  resolveZonedInstant,
  CronExpressionError,
} from '../lib/cron.js'

const iso = (ms) => new Date(ms).toISOString()

test('canonicalizeTimezone accepts UTC and IANA names, rejects garbage', () => {
  assert.equal(canonicalizeTimezone('UTC'), 'UTC')
  assert.equal(canonicalizeTimezone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(canonicalizeTimezone('America/New_York'), 'America/New_York')
  assert.throws(() => canonicalizeTimezone('Shanghai'), CronExpressionError)
  assert.throws(() => canonicalizeTimezone('Not/AZone'), CronExpressionError)
  assert.throws(() => canonicalizeTimezone(''), CronExpressionError)
})

test('parseExpression rejects wrong field count and out-of-range values', () => {
  assert.throws(() => parseExpression('* * * *'), CronExpressionError)
  assert.throws(() => parseExpression('61 * * * *'), CronExpressionError)
  assert.throws(() => parseExpression('* 24 * * *'), CronExpressionError)
  assert.throws(() => parseExpression('* * 0 * *'), CronExpressionError)
  assert.throws(() => parseExpression('* * * 13 *'), CronExpressionError)
  assert.throws(() => parseExpression('* * * * 8'), CronExpressionError)
  assert.throws(() => parseExpression('* * * * 1-0'), CronExpressionError)
  assert.throws(() => parseExpression('*/0 * * * *'), CronExpressionError)
  assert.throws(() => parseExpression('foo bar baz qux quux'), CronExpressionError)
})

test('parseField handles wildcard, step, range, list, names, ?', () => {
  assert.equal(parseField('*', 'minute'), null)
  assert.equal(parseField('?', 'dom'), null)
  assert.throws(() => parseField('?', 'minute'), CronExpressionError)
  const every5 = parseField('*/5', 'minute')
  assert.deepEqual([...every5.values], [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
  const range = parseField('9-18', 'hour')
  assert.deepEqual([...range.values], [9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
  const list = parseField('1,15,30', 'minute')
  assert.deepEqual([...list.values], [1, 15, 30])
  const names = parseField('MON-FRI', 'dow')
  assert.deepEqual([...names.values], [1, 2, 3, 4, 5])
  const dow7 = parseField('7', 'dow')
  assert.deepEqual([...dow7.values], [0]) // 7 === Sunday
  const months = parseField('JAN,MAR', 'month')
  assert.deepEqual([...months.values], [1, 3])
})

test('every minute: next occurrence is the next minute boundary', () => {
  const from = Date.parse('2026-08-25T12:00:30.000Z')
  const next = nextOccurrence('* * * * *', 'UTC', from)
  assert.equal(iso(next), '2026-08-25T12:01:00.000Z')
})

test('*/5 respects the step grid', () => {
  const from = Date.parse('2026-08-25T12:03:00.000Z')
  const next = nextOccurrence('*/5 * * * *', 'UTC', from)
  assert.equal(iso(next), '2026-08-25T12:05:00.000Z')
  const from2 = Date.parse('2026-08-25T12:57:00.000Z')
  assert.equal(iso(nextOccurrence('*/5 * * * *', 'UTC', from2)), '2026-08-25T13:00:00.000Z')
})

test('daily at 09:00 Asia/Shanghai maps to 01:00Z', () => {
  const from = Date.parse('2026-08-25T12:00:00.000Z') // 20:00 CST
  const next = nextOccurrence('0 9 * * *', 'Asia/Shanghai', from)
  assert.equal(iso(next), '2026-08-26T01:00:00.000Z')
})

test('weekly: 0 9 * * 1-5 from Saturday lands on Monday', () => {
  const saturday = Date.parse('2026-08-22T04:00:00.000Z') // 2026-08-22 is a Saturday
  assert.equal(new Date(saturday).getUTCDay(), 6)
  const next = nextOccurrence('0 9 * * 1-5', 'UTC', saturday)
  const d = new Date(next)
  assert.equal(iso(next), '2026-08-24T09:00:00.000Z')
  assert.equal(d.getUTCDay(), 1)
})

test('names: MON-FRI equals 1-5', () => {
  const from = Date.parse('2026-08-22T04:00:00.000Z')
  assert.equal(nextOccurrence('0 9 * * MON-FRI', 'UTC', from), nextOccurrence('0 9 * * 1-5', 'UTC', from))
})

test('lists: 0 9,18 * * * picks the nearer of 09:00/18:00', () => {
  const from = Date.parse('2026-08-25T08:00:00.000Z')
  assert.equal(iso(nextOccurrence('0 9,18 * * *', 'UTC', from)), '2026-08-25T09:00:00.000Z')
  const from2 = Date.parse('2026-08-25T10:00:00.000Z')
  assert.equal(iso(nextOccurrence('0 9,18 * * *', 'UTC', from2)), '2026-08-25T18:00:00.000Z')
})

test('DST gap: 02:30 on America/New_York spring-forward day does not exist, skips to next day', () => {
  // US DST begins 2026-03-08 (2nd Sunday of March). 02:30 that morning is skipped.
  const from = Date.parse('2026-03-08T06:00:00.000Z') // 01:00 EST, before the gap
  const next = nextOccurrence('30 2 * * *', 'America/New_York', from)
  assert.equal(iso(next), '2026-03-09T06:30:00.000Z') // 02:30 EDT Monday
})

test('DST overlap resolves to the first instant', () => {
  // US DST ends 2026-11-01 (1st Sunday of November): 01:30 happens twice (EDT then EST).
  const from = Date.parse('2026-11-01T04:00:00.000Z') // 00:00 EDT
  const next = nextOccurrence('30 1 * * *', 'America/New_York', from)
  assert.equal(iso(next), '2026-11-01T05:30:00.000Z') // first 01:30 = 05:30Z EDT
})

test('Vixie day rule: 0 0 1 * 1 matches 1st-of-month OR Monday', () => {
  const from = Date.parse('2026-08-20T12:00:00.000Z')
  const next = nextOccurrence('0 0 1 * 1', 'UTC', from)
  assert.equal(iso(next), '2026-08-24T00:00:00.000Z') // Monday Aug 24
  // After Aug 24, the next Monday is Aug 31 — before Sep 1 (1st of month).
  const next2 = nextOccurrence('0 0 1 * 1', 'UTC', Date.parse('2026-08-24T00:00:01.000Z'))
  assert.equal(iso(next2), '2026-08-31T00:00:00.000Z')
  assert.equal(new Date(next2).getUTCDay(), 1)
  // And after Aug 31, the next hit is Sep 1 (Tuesday, dom=1).
  const next3 = nextOccurrence('0 0 1 * 1', 'UTC', Date.parse('2026-08-31T00:00:01.000Z'))
  assert.equal(iso(next3), '2026-09-01T00:00:00.000Z')
})

test('monthly: 0 0 1 * *', () => {
  const from = Date.parse('2026-08-25T00:00:00.000Z')
  assert.equal(iso(nextOccurrence('0 0 1 * *', 'UTC', from)), '2026-09-01T00:00:00.000Z')
})

test('impossible date: 0 0 30 2 * never occurs → null', () => {
  const from = Date.parse('2026-08-25T00:00:00.000Z')
  assert.equal(nextOccurrence('0 0 30 2 *', 'UTC', from), null)
})

test('resolveZonedInstant rejects a DST-gap wall time and accepts an overlap', () => {
  const gap = resolveZonedInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')
  assert.equal(gap, null)
  const overlap = resolveZonedInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York')
  assert.equal(iso(overlap), '2026-11-01T05:30:00.000Z')
})

test('describe renders human labels', () => {
  assert.equal(describe('0 9 * * *'), 'daily at 09:00')
  assert.equal(describe('0 9 * * 1-5'), 'Mon-Fri at 09:00')
  assert.equal(describe('*/5 * * * *'), 'every 5 minutes')
  assert.equal(describe('0 0 1 * *'), 'monthly on day 1 at 00:00')
  assert.equal(describe('0 0 1 * 1'), '0 0 1 * 1')
})

test('nextOccurrence is strictly after fromMs', () => {
  const from = Date.parse('2026-08-25T09:00:00.000Z')
  assert.equal(iso(nextOccurrence('0 9 * * *', 'UTC', from)), '2026-08-26T09:00:00.000Z')
})
