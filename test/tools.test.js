import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronStore } from '../lib/store.js'
import { registerCronTools } from '../lib/tools.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cron-tools-'))
  const store = new CronStore({ logger: { warn: () => {} } }, root)
  store.load()
  const registered = new Map()
  const changes = []
  const rootCtx = {
    logger: { warn: () => {} },
    emit: (name) => changes.push(name),
  }
  const runtime = {
    store: () => store,
    defaultTimezone: 'UTC',
  }
  const toolCtx = {
    tools: {
      register: (def) => {
        registered.set(def.name, def)
        return () => {}
      },
    },
  }
  registerCronTools(rootCtx, toolCtx, runtime, {})
  const execute = async (name, args = {}) => registered.get(name).execute(args, {})
  return { store, registered, changes, execute, root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('tools: all six tools register with compiled schemas', (t) => {
  const { registered, cleanup } = setup()
  t.after(cleanup)
  for (const name of ['cron_create', 'cron_list', 'cron_update', 'cron_delete', 'cron_pause', 'cron_resume']) {
    assert.ok(registered.has(name), `${name} registered`)
    assert.equal(typeof registered.get(name).execute, 'function')
    assert.ok(registered.get(name).parameters.type === 'object')
  }
})

test('tools: cron_create persists a job and emits cron/change', async (t) => {
  const { store, execute, changes, cleanup } = setup()
  t.after(cleanup)
  const result = await execute('cron_create', {
    prompt: 'summarize yesterday',
    schedule: { expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    target: { kind: 'new-chat', project: '/tmp/proj' },
  })
  assert.equal(result.code, undefined)
  assert.equal(result.id, 'cron-1')
  assert.equal(result.state, 'scheduled')
  assert.equal(store.get('cron-1').schedule.timezone, 'Asia/Shanghai')
  assert.equal(store.get('cron-1').target.project, '/tmp/proj')
  assert.ok(changes.includes('cron/change'))
})

test('tools: cron_create rejects bad expressions and missing existing-chat sessionId', async (t) => {
  const { execute, cleanup } = setup()
  t.after(cleanup)
  const badExpression = await execute('cron_create', { prompt: 'x', schedule: { expression: '61 * * * *' } })
  assert.equal(badExpression.code, 'invalid_expression')
  const badZone = await execute('cron_create', { prompt: 'x', schedule: { expression: '0 9 * * *', timezone: 'Mars/Olympus' } })
  assert.equal(badZone.code, 'invalid_time_zone')
  const badTarget = await execute('cron_create', { prompt: 'x', schedule: { expression: '0 9 * * *' }, target: { kind: 'existing-chat' } })
  assert.equal(badTarget.code, 'invalid_target')
  const noPrompt = await execute('cron_create', { prompt: '  ', schedule: { expression: '0 9 * * *' } })
  assert.equal(noPrompt.code, 'invalid_prompt')
})

test('tools: cron_create/cron_update carry target.permissionMode and reject bad values', async (t) => {
  const { store, execute, registered, cleanup } = setup()
  t.after(cleanup)
  const created = await execute('cron_create', {
    prompt: 'a',
    schedule: { expression: '0 9 * * *' },
    target: { kind: 'new-chat', permissionMode: 'danger-full-access' },
  })
  assert.equal(created.id, 'cron-1')
  assert.equal(store.get('cron-1').target.permissionMode, 'danger-full-access')
  assert.equal(created.target.permissionMode, 'danger-full-access')
  // Unknown modes fail at tool-args validation (the schema enum), before the
  // service layer — assert the framework rejection.
  await assert.rejects(
    execute('cron_create', { prompt: 'x', schedule: { expression: '0 9 * * *' }, target: { kind: 'new-chat', permissionMode: 'sudo' } }),
    /permissionMode/
  )
  const updated = await execute('cron_update', { id: 'cron-1', target: { kind: 'new-chat', permissionMode: 'read-only' } })
  assert.equal(updated.target.permissionMode, 'read-only')
  assert.equal(store.get('cron-1').target.permissionMode, 'read-only')
  // null is accepted by the tool args schema and clears the pin.
  const unset = await execute('cron_update', { id: 'cron-1', target: { kind: 'new-chat', permissionMode: null } })
  assert.equal(unset.target.permissionMode, undefined)
  assert.equal(store.get('cron-1').target.permissionMode, undefined)
  // The output schema's target branch declares the mode (no leakage on views).
  const viewSchema = registered.get('cron_create').output.schema.oneOf[0]
  assert.equal(viewSchema.properties.target.properties.permissionMode.enum.includes('danger-full-access'), true)
})

test('tools: cron_list returns views with overdue state', async (t) => {
  const { store, execute, cleanup } = setup()
  t.after(cleanup)
  await execute('cron_create', { prompt: 'a', schedule: { expression: '0 9 * * *' } })
  // Force one job overdue.
  const job = store.get('cron-1')
  store.upsert({ ...job, nextRunAt: new Date(Date.now() - 60_000).toISOString() })
  store.save()
  const list = await execute('cron_list')
  assert.equal(list.length, 1)
  assert.equal(list[0].state, 'overdue')
})

test('tools: cron_update recomputes nextRunAt on schedule change and toggles enabled', async (t) => {
  const { execute, cleanup } = setup()
  t.after(cleanup)
  await execute('cron_create', { prompt: 'a', schedule: { expression: '0 9 * * *' } })
  const before = (await execute('cron_list'))[0]
  const updated = await execute('cron_update', { id: 'cron-1', schedule: { expression: '30 18 * * 1-5' } })
  assert.notEqual(updated.nextRunAt, before.nextRunAt)
  assert.equal(updated.schedule.expression, '30 18 * * 1-5')
  const paused = await execute('cron_update', { id: 'cron-1', enabled: false })
  assert.equal(paused.enabled, false)
  assert.equal(paused.state, 'disabled')
  const missing = await execute('cron_update', { id: 'cron-99' })
  assert.equal(missing.code, 'not_found')
})

test('tools: every view key is declared in the output schema (no additionalProperties leakage)', async (t) => {
  const { execute, registered, cleanup } = setup()
  t.after(cleanup)
  await execute('cron_create', { prompt: 'a', schedule: { expression: '0 9 * * *' } })
  const view = await execute('cron_list')
  assert.equal(view.length, 1)
  // CREATE_OUTPUT_SCHEMA = { oneOf: [VIEW_SCHEMA, ...error schemas] }; branch 0 is the view.
  const viewSchema = registered.get('cron_create').output.schema.oneOf[0]
  assert.ok(viewSchema && viewSchema.type === 'object')
  for (const job of view) {
    for (const key of Object.keys(job)) {
      assert.ok(viewSchema.properties[key], `view key "${key}" must be declared in VIEW_SCHEMA`)
    }
  }
  // And the view round-trips through the schema's required fields.
  for (const required of Object.keys(viewSchema.properties).filter((k) => viewSchema.properties[k].required)) {
    assert.ok(required in view[0], `view must include required field "${required}"`)
  }
})

test('tools: cron_list view with null nextRunAt/lastRunAt validates against the harness output schema', async (t) => {
  const { execute, registered, cleanup } = setup()
  t.after(cleanup)
  // Fresh job: lastRunAt is null until the first run; a disabled/unreachable
  // job may also carry nextRunAt null. Both must validate (regression: the
  // VIEW_SCHEMA once declared them as plain strings, so real views with null
  // failed the harness's oneOf output validation with "matched 0").
  await execute('cron_create', { prompt: 'a', schedule: { expression: '0 9 * * *' } })
  const view = await execute('cron_list')
  assert.equal(view.length, 1)
  assert.equal(view[0].lastRunAt, null)
  const listSchema = registered.get('cron_list').output.schema
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  const violations = validateJsonSchemaValue(listSchema, view, 'value')
  assert.deepEqual(violations, [])
})

test('tools: cron_delete, cron_pause, cron_resume behave', async (t) => {
  const { execute, cleanup } = setup()
  t.after(cleanup)
  await execute('cron_create', { prompt: 'a', schedule: { expression: '0 9 * * *' } })
  const paused = await execute('cron_pause', { id: 'cron-1' })
  assert.equal(paused.enabled, false)
  const resumed = await execute('cron_resume', { id: 'cron-1' })
  assert.equal(resumed.enabled, true)
  assert.equal(resumed.state, 'scheduled')
  const deleted = await execute('cron_delete', { id: 'cron-1' })
  assert.equal(deleted.deleted, true)
  const gone = await execute('cron_delete', { id: 'cron-1' })
  assert.equal(gone.deleted, false)
  assert.equal(gone.code, 'not_found')
  const missing = await execute('cron_pause', { id: 'cron-9' })
  assert.equal(missing.code, 'not_found')
})
