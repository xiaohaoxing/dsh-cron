/**
 * Browser-facing REST + SSE bridge for @dsh/cron.
 *
 * Registered on the harness `webServer` (the same server that serves the web
 * shell), so the client bundle can fetch same-origin:
 *
 *   GET    /cron-api/jobs          → { jobs: [view], timezone }
 *   POST   /cron-api/jobs          → create (body = create args) → view
 *   PATCH  /cron-api/jobs/<id>     → update (body = field patch) → view
 *   DELETE /cron-api/jobs/<id>     → { id, deleted }
 *   GET    /cron-api/events        → SSE stream: `change` / `run` events
 *
 * Mutations share the exact service layer the model tools use
 * (`service.js`): one validation + persistence code path. Every mutation also
 * emits `cron/change` on the plugin context, which both drives the scheduler
 * and notifies SSE clients. The SSE stream is purely an observer — clients
 * refetch `GET /cron-api/jobs` after `change`/`run` events, so there is no
 * replay/seq machinery.
 *
 * No authentication is applied: like `/plugins/*`, these routes are open on
 * the local harness bind (127.0.0.1 / trusted hosts).
 */

import { describe } from './cron.js'
import { createJob, deleteJob, listViews, pauseJob, resumeJob, updateJob } from './service.js'

const MAX_BODY_BYTES = 64 * 1024
const SSE_KEEPALIVE_MS = 25_000

/** Parse `req.url` into { pathname, segments }. */
function parsePath(req) {
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://local').pathname
  } catch {
    pathname = '/'
  }
  return { pathname, segments: pathname.split('/').filter(Boolean) }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Collect the request body with a size cap; resolves to '' on empty body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function parseJsonBody(req, res) {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    sendJson(res, 400, { ok: false, code: 'invalid_body', message: 'request body must be valid JSON.' })
    return null
  }
}

/** Map a service error object to an HTTP status. */
function statusOfError(error) {
  switch (error.code) {
    case 'not_found': return 404
    case 'persistence_uncertain':
    case 'internal_error': return 500
    default: return 400
  }
}

function errorBody(error) {
  return { ok: false, ...error }
}

/** API view = tool view plus a human-readable schedule label for the browser. */
function viewWithLabel(view) {
  let label
  try {
    label = describe(view.schedule.expression)
  } catch {
    label = view.schedule.expression
  }
  return { ...view, label }
}

/** Respond to a create/update/pause/resume result with the right HTTP status. */
function respondJob(res, result) {
  if (!result.ok) {
    sendJson(res, statusOfError(result.error), errorBody(result.error))
    return
  }
  sendJson(res, 200, { ok: true, view: viewWithLabel(result.view) })
}

/**
 * Register the cron API routes and SSE stream. Idempotent disposer; wire it
 * through `ctx.effect` so teardown unregisters routes and listeners.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {import('./runtime.js').CronRuntime} runtime - scheduler runtime.
 * @param {{ timezone?: string }} [defaults]
 * @returns {() => void} disposer.
 */
export function registerCronApi(ctx, runtime, defaults = {}) {
  // Safe lookup: direct `ctx.webServer` access would throw "without inject" on
  // a context that does not declare the service; `get` returns undefined when
  // the harness does not mount a web server (e.g. headless profiles).
  const webServer = ctx.get('webServer')
  const disposers = []
  const logger = ctx.logger
  if (webServer === undefined) {
    logger.warn('[cron] webServer service not available — /cron-api routes not registered')
    return () => {}
  }
  const sseClients = new Set()

  const broadcast = (kind, payload) => {
    for (const res of sseClients) {
      try {
        res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`)
      } catch (error) {
        logger.warn(`cron: sse write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Mutations must drive the scheduler, not just inform SSE clients: emitting
  // `cron/change` on the plugin context is what index.js listens for to re-arm
  // the runtime (`requestDrive`). The `ctx.on('cron/change', onChange)`
  // subscription below then fans the same event out to live SSE streams, so a
  // UI-created/edited job is picked up by the scheduler immediately instead of
  // sitting overdue until some other event happens to drive it.
  const notifyChange = () => {
    try {
      ctx.emit('cron/change')
    } catch (error) {
      logger.warn(`cron: change observer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const route = webServer.register({
    kind: 'prefix',
    path: '/cron-api',
    handler: async (req, res) => {
      const { segments } = parsePath(req)
      const method = req.method ?? 'GET'
      try {
        if (segments.length === 2 && segments[0] === 'cron-api' && segments[1] === 'jobs') {
          if (method === 'GET') {
            sendJson(res, 200, { ok: true, jobs: listViews(runtime).map(viewWithLabel), timezone: defaults.timezone ?? runtime.defaultTimezone })
            return
          }
          if (method === 'POST') {
            const body = await parseJsonBody(req, res)
            if (body === null) return
            respondJob(res, createJob(runtime, defaults, body, logger))
            notifyChange()
            return
          }
        }
        if (segments.length === 2 && segments[0] === 'cron-api' && segments[1] === 'events' && method === 'GET') {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          sseClients.add(res)
          res.write(': connected\n\n')
          const keepalive = setInterval(() => {
            try {
              res.write(': ping\n\n')
            } catch {
              clearInterval(keepalive)
            }
          }, SSE_KEEPALIVE_MS)
          const close = () => {
            clearInterval(keepalive)
            sseClients.delete(res)
          }
          req.on('close', close)
          res.on('close', close)
          return
        }
        if (segments.length === 3 && segments[0] === 'cron-api') {
          const id = decodeURIComponent(segments[2])
          if (method === 'PATCH') {
            const body = await parseJsonBody(req, res)
            if (body === null) return
            respondJob(res, updateJob(runtime, id, body, logger))
            notifyChange()
            return
          }
          if (method === 'DELETE') {
            const result = deleteJob(runtime, id, logger)
            if (!result.ok) {
              sendJson(res, statusOfError(result.error), errorBody(result.error))
            } else {
              sendJson(res, 200, { ok: true, ...result.result })
            }
            notifyChange()
            return
          }
        }
        sendJson(res, 404, { ok: false, code: 'not_found', message: `no cron api route for ${method} ${req.url}.` })
      } catch (error) {
        logger.warn(`cron: api handler failed: ${error instanceof Error ? error.message : String(error)}`)
        sendJson(res, 500, errorBody({ code: 'internal_error', message: 'The cron api operation failed.' }))
      }
    },
  })
  if (typeof route === 'function') disposers.push(route)

  const onChange = () => broadcast('change', {})
  const onRun = (payload) => broadcast('run', payload)
  const offChange = ctx.on('cron/change', onChange)
  const offRun = ctx.on('cron/run', onRun)
  if (typeof offChange === 'function') disposers.push(offChange)
  if (typeof offRun === 'function') disposers.push(offRun)

  let active = true
  logger.info('[cron] /cron-api routes registered (jobs REST + events SSE)')
  return () => {
    if (!active) return
    active = false
    for (const res of sseClients) {
      try {
        res.end()
      } catch {
        /* already closed */
      }
    }
    sseClients.clear()
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* best-effort teardown */
      }
    }
  }
}
