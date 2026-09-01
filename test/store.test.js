import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronStore, CronStoreError, validateJob, assertScheduleValid } from '../lib/store.js'
import { CronExpressionError } from '../lib/cron.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-cron-store-'))
}

function quietCtx() {
  return { logger: { warn: () => {} } }
}

function baseJob(overrides = {}) {
  const now = new Date().toISOString()
  return {
    id: 'cron-1',
    title: 'test',
    prompt: 'run the tests',
    schedule: { expression: '0 9 * * *', timezone: 'UTC' },
    target: { kind: 'new-chat' },
    notification: { mode: 'session' },
    enabled: true,
    nextRunAt: now,
    lastRunAt: null,
    runHistory: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

test('store: save/load roundtrip preserves jobs and monotonic ids', () => {
  const root = tempRoot()
  try {
    const store = new CronStore(quietCtx(), root)
    store.load()
    const id1 = store.allocateId()
    assert.equal(id1, 'cron-1')
    const id2 = store.allocateId()
    assert.equal(id2, 'cron-2')
    store.upsert(baseJob({ id: id1 }))
    store.upsert(baseJob({ id: id2, title: 'second' }))
    store.save()

    const reloaded = new CronStore(quietCtx(), root)
    reloaded.load()
    assert.equal(reloaded.size, 2)
    assert.equal(reloaded.get('cron-1').title, 'test')
    assert.equal(reloaded.get('cron-2').title, 'second')
    assert.equal(reloaded.allocateId(), 'cron-3')

    const onDisk = JSON.parse(readFileSync(join(root, 'jobs.json'), 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.jobs.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store: missing file loads empty', () => {
  const root = tempRoot()
  try {
    const store = new CronStore(quietCtx(), root)
    store.load()
    assert.equal(store.size, 0)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store: corrupt file throws CronStoreError', () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'jobs.json'), 'not json{')
    const store = new CronStore(quietCtx(), root)
    assert.throws(() => store.load(), CronStoreError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store: invalid job records are dropped at load, valid ones survive', () => {
  const root = tempRoot()
  try {
    const good = baseJob({ id: 'cron-1' })
    const bad = { id: 'cron-2', prompt: '', schedule: { expression: 'nope' } }
    writeFileSync(join(root, 'jobs.json'), JSON.stringify({ version: 1, nextId: 3, jobs: [good, bad] }))
    const store = new CronStore(quietCtx(), root)
    store.load()
    assert.equal(store.size, 1)
    assert.equal(store.get('cron-1').id, 'cron-1')
    assert.equal(store.allocateId(), 'cron-3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store: remove and upsert-replace', () => {
  const root = tempRoot()
  try {
    const store = new CronStore(quietCtx(), root)
    store.load()
    store.upsert(baseJob({ id: 'cron-1' }))
    store.upsert(baseJob({ id: 'cron-1', title: 'renamed' }))
    assert.equal(store.get('cron-1').title, 'renamed')
    assert.equal(store.remove('cron-1'), true)
    assert.equal(store.remove('cron-1'), false)
    assert.equal(store.size, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validateJob enforces existing-chat sessionId and safe id charset', () => {
  assert.throws(() => validateJob(baseJob({ target: { kind: 'existing-chat' } })), /sessionId is required/)
  assert.throws(() => validateJob(baseJob({ id: 'bad id!' })), /safe identifier/)
  assert.doesNotThrow(() => validateJob(baseJob({ target: { kind: 'existing-chat', sessionId: 'abc-123' } })))
})

test('validateJob accepts every sandbox permission mode and rejects anything else', () => {
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    const job = validateJob(baseJob({ target: { kind: 'new-chat', permissionMode: mode } }))
    assert.equal(job.target.permissionMode, mode)
  }
  assert.equal(validateJob(baseJob({ target: { kind: 'new-chat' } })).target.permissionMode, undefined)
  // null is the "clear" marker: the pin is dropped, never persisted as null.
  assert.equal(validateJob(baseJob({ target: { kind: 'new-chat', permissionMode: null } })).target.permissionMode, undefined)
  assert.throws(() => validateJob(baseJob({ target: { kind: 'new-chat', permissionMode: 'sudo' } })), /permissionMode/)
  assert.throws(() => validateJob(baseJob({ target: { kind: 'new-chat', permissionMode: 42 } })), /permissionMode/)
})

test('store: permissionMode survives the save/load roundtrip', () => {
  const root = tempRoot()
  try {
    const store = new CronStore(quietCtx(), root)
    store.load()
    store.upsert(baseJob({ id: 'cron-1', target: { kind: 'new-chat', permissionMode: 'danger-full-access' } }))
    store.save()
    const reloaded = new CronStore(quietCtx(), root)
    reloaded.load()
    assert.equal(reloaded.get('cron-1').target.permissionMode, 'danger-full-access')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('assertScheduleValid rejects bad expressions and timezones', () => {
  assert.throws(() => assertScheduleValid('61 * * * *', 'UTC'), CronExpressionError)
  assert.throws(() => assertScheduleValid('0 9 * * *', 'Shanghai'), CronExpressionError)
  assert.doesNotThrow(() => assertScheduleValid('0 9 * * 1-5', 'Asia/Shanghai'))
})
