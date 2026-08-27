import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronStore } from '../lib/store.js'
import { CronRuntime } from '../lib/runtime.js'
import { createJob, updateJob, deleteJob, pauseJob, resumeJob, listViews } from '../lib/service.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cron-svc-'))
  const store = new CronStore({ logger: { warn: () => {} } }, root)
  store.load()
  const ctx = {
    logger: { warn: () => {} },
    emit: () => {},
    agents: { withoutInitiator: (fn) => fn(), get: () => undefined, create: async () => { throw new Error('probe') }, resume: async () => { throw new Error('probe') } },
  }
  const runtime = new CronRuntime(ctx, store, {})
  const defaults = { timezone: 'UTC' }
  const base = { prompt: 'do the thing', schedule: { expression: '0 9 * * *', timezone: 'UTC' } }
  return { store, runtime, defaults, base, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('service: createJob builds a full job with next occurrence and id', (t) => {
  const { store, runtime, defaults, base, cleanup } = setup()
  t.after(cleanup)
  const result = createJob(runtime, defaults, { ...base, title: 'Morning', target: { kind: 'new-chat', project: '/tmp/p', reasoningEffort: 'high' } })
  assert.equal(result.ok, true)
  assert.equal(result.view.id, 'cron-1')
  assert.equal(result.view.title, 'Morning')
  assert.equal(result.view.schedule.timezone, 'UTC')
  assert.equal(result.view.target.project, '/tmp/p')
  assert.equal(result.view.state, 'scheduled')
  assert.ok(Date.parse(result.view.nextRunAt) > Date.now())
  assert.equal(store.get('cron-1').prompt, 'do the thing')
})

test('service: createJob validation errors use closed-union codes', (t) => {
  const { runtime, defaults, cleanup } = setup()
  t.after(cleanup)
  const badExpr = createJob(runtime, defaults, { prompt: 'x', schedule: { expression: '61 * * * *' } })
  assert.deepEqual(badExpr.error.code, 'invalid_expression')
  const badZone = createJob(runtime, defaults, { prompt: 'x', schedule: { expression: '0 9 * * *', timezone: 'Mars/Olympus' } })
  assert.deepEqual(badZone.error.code, 'invalid_time_zone')
  const badTarget = createJob(runtime, defaults, { prompt: 'x', schedule: { expression: '0 9 * * *' }, target: { kind: 'existing-chat' } })
  assert.deepEqual(badTarget.error.code, 'invalid_target')
  const noPrompt = createJob(runtime, defaults, { prompt: '  ', schedule: { expression: '0 9 * * *' } })
  assert.deepEqual(noPrompt.error.code, 'invalid_prompt')
})

test('service: updateJob recomputes nextRunAt on schedule change and toggles enabled', (t) => {
  const { store, runtime, defaults, base, cleanup } = setup()
  t.after(cleanup)
  createJob(runtime, defaults, base)
  const before = store.get('cron-1').nextRunAt
  const updated = updateJob(runtime, 'cron-1', { schedule: { expression: '30 18 * * 1-5' } })
  assert.equal(updated.ok, true)
  assert.notEqual(updated.view.nextRunAt, before)
  assert.equal(updated.view.schedule.expression, '30 18 * * 1-5')
  const paused = updateJob(runtime, 'cron-1', { enabled: false })
  assert.equal(paused.ok, true)
  assert.equal(paused.view.enabled, false)
  assert.equal(paused.view.state, 'disabled')
  const missing = updateJob(runtime, 'cron-99', { enabled: true })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'not_found')
})

test('service: pause/resume/delete/list behave', (t) => {
  const { store, runtime, defaults, base, cleanup } = setup()
  t.after(cleanup)
  createJob(runtime, defaults, base)
  createJob(runtime, defaults, { prompt: 'second', schedule: { expression: '0 12 * * *' } })
  const paused = pauseJob(runtime, 'cron-1')
  assert.equal(paused.view.enabled, false)
  const resumed = resumeJob(runtime, 'cron-1')
  assert.equal(resumed.view.enabled, true)
  assert.equal(resumed.view.state, 'scheduled')
  const deleted = deleteJob(runtime, 'cron-1')
  assert.deepEqual(deleted.result, { id: 'cron-1', deleted: true })
  assert.equal(store.get('cron-1'), undefined)
  const gone = deleteJob(runtime, 'cron-1')
  assert.deepEqual(gone.result, { id: 'cron-1', deleted: false, code: 'not_found' })
  const views = listViews(runtime)
  assert.equal(views.length, 1)
  assert.equal(views[0].id, 'cron-2')
  const badId = pauseJob(runtime, ' bad id ')
  assert.equal(badId.ok, false)
  assert.equal(badId.error.code, 'invalid_id')
})
