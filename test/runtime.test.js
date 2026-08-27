import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronStore } from '../lib/store.js'
import { CronRuntime } from '../lib/runtime.js'
import { nextOccurrence } from '../lib/cron.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-cron-runtime-'))
}

function fakeAgent(sessionId) {
  return {
    session: { id: sessionId },
    followup() {},
    runMaintenance: async (job) => job(),
    dispose: async () => {},
  }
}

/** Mock cordis context: enough of agents/emit/logger for the runtime. */
function makeCtx({ live = new Map(), onCreate, onResume } = {}) {
  const observations = { emits: [], warns: [], created: [], resumed: [] }
  return {
    observations,
    logger: {
      warn: (message) => observations.warns.push(String(message)),
    },
    emit: (name, payload) => observations.emits.push({ name, payload }),
    agents: {
      withoutInitiator: (fn) => fn(),
      get: (id) => live.get(id),
      create: async (options) => {
        observations.created.push(options)
        const agent = fakeAgent(options.sessionId)
        onCreate?.(agent, options)
        return { agent, dispose: async () => agent.dispose() }
      },
      resume: async (options) => {
        observations.resumed.push(options)
        const agent = fakeAgent(options.resumeSessionId)
        onResume?.(agent, options)
        return { agent, dispose: async () => agent.dispose() }
      },
    },
  }
}

function jobWith({ expression = '0 9 * * *', timezone = 'UTC', nextRunAt, target = { kind: 'new-chat' }, enabled = true, catchUp } = {}) {
  const now = new Date().toISOString()
  const next = nextRunAt ?? nowIso(nextOccurrence(expression, timezone, Date.now()))
  return {
    id: 'cron-1',
    title: 'test job',
    prompt: 'do the thing',
    schedule: { expression, timezone },
    target,
    notification: { mode: 'session' },
    enabled,
    nextRunAt: next,
    lastRunAt: null,
    runHistory: [],
    createdAt: now,
    updatedAt: now,
    catchUp,
  }
}

function nowIso(epoch = Date.now()) {
  return new Date(epoch).toISOString()
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test('runtime: overdue job with catchUp=false skips missed occurrences and advances nextRunAt', async () => {
  const root = tempRoot()
  try {
    const store = new CronStore({ logger: { warn: () => {} } }, root)
    store.load()
    const overdue = nowIso(Date.now() - 2 * 3600 * 1000) // 2h ago; hourly job → 2 missed
    store.upsert(jobWith({ expression: '0 * * * *', nextRunAt: overdue }))
    store.save()
    const ctx = makeCtx()
    const runtime = new CronRuntime(ctx, store, {})
    runtime.start()
    await settle()
    const job = store.get('cron-1')
    assert.equal(job.enabled, true)
    assert.ok(Date.parse(job.nextRunAt) > Date.now(), 'nextRunAt advanced past now')
    assert.ok(job.runHistory.some((entry) => entry.status === 'skipped'), 'missed occurrences recorded as skipped')
    assert.equal(ctx.observations.created.length, 0, 'no execution spawned when skipping')
    await runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime: overdue job with catchUp=true executes once (new-chat agent created)', async () => {
  const root = tempRoot()
  try {
    const store = new CronStore({ logger: { warn: () => {} } }, root)
    store.load()
    store.upsert(jobWith({ expression: '0 * * * *', nextRunAt: nowIso(Date.now() - 3600 * 1000) }))
    store.save()
    const ctx = makeCtx()
    const runtime = new CronRuntime(ctx, store, { catchUp: true })
    runtime.start()
    await settle()
    assert.equal(ctx.observations.created.length, 1, 'one run agent created')
    const created = ctx.observations.created[0]
    assert.ok(created.sessionId.startsWith('cron-1-'), 'run session id derived from job')
    assert.equal(created.agentOptions.provider, undefined, 'no default provider configured')
    const job = store.get('cron-1')
    assert.ok(job.lastRunAt !== null)
    assert.ok(job.runHistory.some((entry) => entry.status === 'ok' && entry.sessionId === created.sessionId))
    assert.ok(ctx.observations.emits.some((e) => e.name === 'cron/run' && e.payload.status === 'ok'))
    await runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime: new-chat run carries project cwd, provider, model, reasoningEffort', async () => {
  const root = tempRoot()
  try {
    const store = new CronStore({ logger: { warn: () => {} } }, root)
    store.load()
    store.upsert(jobWith({
      nextRunAt: nowIso(Date.now() - 1000),
      target: { kind: 'new-chat', project: '/tmp/proj', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    }))
    store.save()
    const ctx = makeCtx()
    const runtime = new CronRuntime(ctx, store, { catchUp: true })
    runtime.start()
    await settle()
    const created = ctx.observations.created[0]
    assert.deepEqual(created.meta, { cwd: '/tmp/proj' })
    assert.equal(created.agentOptions.provider, 'deepseek-official')
    assert.equal(created.agentOptions.model, 'deepseek-v4-flash')
    assert.equal(created.agentOptions.reasoningEffort, 'high')
    await runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime: existing-chat delivers into the live agent without creating one', async () => {
  const root = tempRoot()
  try {
    const store = new CronStore({ logger: { warn: () => {} } }, root)
    store.load()
    const liveAgent = fakeAgent('existing-session-1')
    let delivered = 0
    liveAgent.runMaintenance = async (job) => {
      delivered += 1
      await job()
      return true
    }
    const ctx = makeCtx({ live: new Map([['existing-session-1', liveAgent]]) })
    store.upsert(jobWith({ nextRunAt: nowIso(Date.now() - 1000), target: { kind: 'existing-chat', sessionId: 'existing-session-1' } }))
    store.save()
    const runtime = new CronRuntime(ctx, store, { catchUp: true })
    runtime.start()
    await settle()
    assert.equal(delivered, 1, 'followup delivered via runMaintenance')
    assert.equal(ctx.observations.created.length, 0)
    assert.equal(ctx.observations.resumed.length, 0)
    const job = store.get('cron-1')
    assert.equal(job.runHistory[0].sessionId, 'existing-session-1')
    await runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime: existing-chat session not live is resumed from persistence', async () => {
  const root = tempRoot()
  try {
    const store = new CronStore({ logger: { warn: () => {} } }, root)
    store.load()
    const ctx = makeCtx()
    store.upsert(jobWith({ nextRunAt: nowIso(Date.now() - 1000), target: { kind: 'existing-chat', sessionId: 'persisted-1' } }))
    store.save()
    const runtime = new CronRuntime(ctx, store, { catchUp: true })
    runtime.start()
    await settle()
    assert.equal(ctx.observations.resumed.length, 1)
    assert.deepEqual(ctx.observations.resumed[0].resumeSessionId, 'persisted-1')
    await runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime: execution failure is contained and recorded', async () => {
  const root = tempRoot()
  try {
    const store = new CronStore({ logger: { warn: () => {} } }, root)
    store.load()
    store.upsert(jobWith({ nextRunAt: nowIso(Date.now() - 1000) }))
    store.save()
    const ctx = makeCtx({
      onCreate: () => {
        throw new Error('boom')
      },
    })
    const runtime = new CronRuntime(ctx, store, { catchUp: true })
    runtime.start()
    await settle()
    const job = store.get('cron-1')
    assert.equal(job.runHistory[0].status, 'failed')
    assert.match(job.runHistory[0].error, /boom/)
    assert.ok(ctx.observations.emits.some((e) => e.name === 'cron/run' && e.payload.status === 'failed'))
    assert.ok(ctx.observations.warns.some((w) => w.includes('run failed')))
    await runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime: future job is not executed and stays armed', async () => {
  const root = tempRoot()
  try {
    const store = new CronStore({ logger: { warn: () => {} } }, root)
    store.load()
    const future = nowIso(Date.now() + 3600 * 1000)
    store.upsert(jobWith({ nextRunAt: future }))
    store.save()
    const ctx = makeCtx()
    const runtime = new CronRuntime(ctx, store, { catchUp: true })
    runtime.start()
    await settle()
    assert.equal(ctx.observations.created.length, 0)
    assert.equal(store.get('cron-1').nextRunAt, future)
    await runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime: maxLiveRunAgents trims oldest run agents', async () => {
  const root = tempRoot()
  try {
    const store = new CronStore({ logger: { warn: () => {} } }, root)
    store.load()
    const disposed = []
    const ctx = makeCtx({
      onCreate: (agent, options) => {
        const original = agent.dispose
        agent.dispose = async () => {
          disposed.push(options.sessionId)
          await original()
        }
      },
    })
    store.upsert(jobWith({ expression: '* * * * *', nextRunAt: nowIso(Date.now() - 2000) }))
    store.save()
    const runtime = new CronRuntime(ctx, store, { catchUp: true, maxLiveRunAgents: 1 })
    // Two consecutive runs (force a second drive by mutating nextRunAt back).
    runtime.start()
    await settle()
    const job = store.get('cron-1')
    store.upsert({ ...job, nextRunAt: nowIso(Date.now() - 1000) })
    store.save()
    runtime.requestDrive()
    await settle()
    assert.equal(ctx.observations.created.length, 2)
    assert.equal(disposed.length, 1, 'oldest run agent released when over cap')
    await runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
