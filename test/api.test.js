import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronStore } from '../lib/store.js'
import { CronRuntime } from '../lib/runtime.js'
import { registerCronApi } from '../lib/api.js'

function makeCtx(webServer) {
  const listeners = new Map()
  return {
    get: (name) => (name === 'webServer' ? webServer : undefined),
    logger: { warn: () => {}, info: () => {} },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {
        const arr = listeners.get(name)
        if (arr) {
          const i = arr.indexOf(fn)
          if (i !== -1) arr.splice(i, 1)
        }
      }
    },
    emit: (name, payload) => {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
    _listeners: listeners,
  }
}

function makeRes() {
  const res = new EventEmitter()
  res.status = 200
  res.headers = {}
  res.body = null
  res.chunks = []
  res.writeHead = function (status, headers) {
    this.status = status
    this.headers = headers
  }
  res.end = function (body) {
    this.body = body
    this.ended = true
  }
  res.write = function (chunk) {
    this.chunks.push(String(chunk))
  }
  return res
}

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  } else {
    queueMicrotask(() => req.emit('end'))
  }
  return req
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cron-api-'))
  const store = new CronStore({ logger: { warn: () => {} } }, root)
  store.load()
  const routes = []
  const ctx = makeCtx({ register: (route) => {
    routes.push(route)
    return () => {}
  } })
  const runtime = new CronRuntime(ctx, store, {})
  const dispose = registerCronApi(ctx, runtime, { timezone: 'UTC' })
  const handler = routes[0].handler
  const call = async (method, url, body) => {
    const res = makeRes()
    const req = makeReq(method, url, body)
    await handler(req, res)
    return { res, status: res.status, body: res.body === null ? null : JSON.parse(res.body) }
  }
  return { store, runtime, ctx, handler, call, cleanup: () => { dispose(); rmSync(root, { recursive: true, force: true }) } }
}

test('api: GET /cron-api/jobs lists jobs with label', async (t) => {
  const { store, call, cleanup } = setup()
  t.after(cleanup)
  store.upsert({
    id: 'cron-1', title: 'Morning', prompt: 'p', schedule: { expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    target: { kind: 'new-chat' }, notification: { mode: 'session' }, enabled: true,
    nextRunAt: new Date(Date.now() + 3600000).toISOString(), lastRunAt: null, runHistory: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
  store.save()
  const { status, body } = await call('GET', '/cron-api/jobs')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.timezone, 'UTC')
  assert.equal(body.jobs.length, 1)
  assert.equal(body.jobs[0].id, 'cron-1')
  assert.equal(typeof body.jobs[0].label, 'string')
  assert.ok(body.jobs[0].label.length > 0)
})

test('api: POST creates and PATCH/DELETE mutate with error mapping', async (t) => {
  const { store, call, cleanup } = setup()
  t.after(cleanup)
  const created = await call('POST', '/cron-api/jobs', JSON.stringify({ prompt: 'do it', schedule: { expression: '0 9 * * *' } }))
  assert.equal(created.status, 200)
  assert.equal(created.body.ok, true)
  assert.equal(created.body.view.id, 'cron-1')
  const bad = await call('POST', '/cron-api/jobs', JSON.stringify({ prompt: 'x', schedule: { expression: '99 * * * *' } }))
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'invalid_expression')
  const patched = await call('PATCH', '/cron-api/jobs/cron-1', JSON.stringify({ enabled: false }))
  assert.equal(patched.status, 200)
  assert.equal(patched.body.view.enabled, false)
  const missing = await call('PATCH', '/cron-api/jobs/cron-99', JSON.stringify({ enabled: true }))
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'not_found')
  const deleted = await call('DELETE', '/cron-api/jobs/cron-1')
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.deleted, true)
  assert.equal(store.get('cron-1'), undefined)
  const unknown = await call('DELETE', '/cron-api/jobs/cron-1')
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.deleted, false)
})

test('api: SSE stream broadcasts cron/change and cron/run', async (t) => {
  const { ctx, handler, cleanup } = setup()
  t.after(cleanup)
  const res = makeRes()
  const req = makeReq('GET', '/cron-api/events')
  await handler(req, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  ctx.emit('cron/change')
  ctx.emit('cron/run', { jobId: 'cron-1', occurrence: '2026-08-25T01:00:00.000Z', status: 'ok', sessionId: 'cron-1-1' })
  assert.ok(res.chunks.some((c) => c.includes('event: change')))
  assert.ok(res.chunks.some((c) => c.includes('event: run') && c.includes('cron-1')))
  // Close the stream so the keepalive interval is torn down (process exits).
  req.emit('close')
  res.emit('close')
})

test('api: mutations broadcast change to connected SSE clients (no recursion)', async (t) => {
  const { handler, cleanup } = setup()
  t.after(cleanup)
  const sse = makeRes()
  const sseReq = makeReq('GET', '/cron-api/events')
  await handler(sseReq, sse)
  assert.equal(sse.status, 200)
  assert.ok(sse.chunks.some((c) => c.includes(': connected')))
  // POST through the route must fan out `event: change` to the live stream.
  const postRes = makeRes()
  const postReq = makeReq('POST', '/cron-api/jobs', JSON.stringify({ prompt: 'do it', schedule: { expression: '0 9 * * *' } }))
  await handler(postReq, postRes)
  assert.equal(postRes.status, 200)
  assert.ok(sse.chunks.some((c) => c.includes('event: change')), 'SSE client must receive change after POST')
  // PATCH likewise.
  const patchRes = makeRes()
  const patchReq = makeReq('PATCH', '/cron-api/jobs/cron-1', JSON.stringify({ enabled: false }))
  await handler(patchReq, patchRes)
  assert.equal(patchRes.status, 200)
  assert.ok(sse.chunks.some((c) => c.includes('event: change')), 'SSE client must receive change after PATCH')
  sseReq.emit('close')
  sse.emit('close')
})
