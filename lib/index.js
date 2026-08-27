/**
 * @dsh/cron — cron executor plugin for DeepSeek Harness.
 *
 * A Cordis function plugin: exports `name`, `inject`, and `apply(ctx, config)`.
 * Mount it in a profile's `cordis.patch.yml`:
 *
 *   - insert:
 *       - id: cron
 *         name: '@dsh/cron'
 *         config: { timezone: 'Asia/Shanghai' }
 *
 * Config:
 *   root                task-table directory (default dshHomePath('cron'))
 *   timezone            default IANA timezone (default 'UTC')
 *   catchUp             whether to run missed occurrences after downtime (default false)
 *   maxLiveRunAgents    live run-agent cap (default 20; released agents keep
 *                       their persisted sessions)
 *   defaultProvider     provider for run agents (default deepseek-official)
 *   defaultModel        model for run agents (default deepseek-v4-flash)
 *
 * Events emitted on this plugin's context:
 *   cron/change  — after any store mutation (scheduler re-arms)
 *   cron/run     — { jobId, occurrence, status: started|ok|failed, sessionId?, error? }
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { CronStore } from './store.js'
import { CronRuntime } from './runtime.js'
import { registerCronTools } from './tools.js'
import { registerCronApi } from './api.js'

/**
 * Resolve a path under the DeepSeek Harness home (same contract as
 * `@deepseek-ai/dsh-home-paths`, vendored so the plugin has zero framework
 * imports and installs from any directory): `$DSH_HOME` when set, else
 * `~/.dsh`. The `root` config may override the task-table location entirely.
 */
export function dshHomePath(...parts) {
	const root = (process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh'))
	return join(root, ...parts)
}

export const name = 'cron'
// `webServer` is injected (not just looked up) so the loader keeps this fiber
// inactive until the webserver host is active — the same pattern dsh-client-hmr
// uses. In a headless profile without webServer the fiber stays inactive and
// the plugin simply does not start (graceful, no boot error).
// `agentPresets` lets run agents join the deployment's default agent preset
// (core tools like bash live in the preset composition, not the global layer).
export const inject = ['agents', 'sessions', 'tools', 'sessionPersistence', 'webServer', 'agentPresets']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   root?: string,
 *   timezone?: string,
 *   catchUp?: boolean,
 *   maxLiveRunAgents?: number,
 *   defaultProvider?: string,
 *   defaultModel?: string,
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const root = typeof config.root === 'string' && config.root.length > 0 ? config.root : dshHomePath('cron')
  const store = new CronStore(ctx, root)
  const runtime = new CronRuntime(ctx, store, config)
  let storeLoaded = false

  ctx.effect(() => {
    try {
      store.load()
      storeLoaded = true
    } catch (error) {
      // Contained: the harness keeps booting; scheduling simply stays off.
      ctx.logger.warn(`cron: scheduler disabled: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
    const stopChange = ctx.on('cron/change', () => runtime.requestDrive())
    runtime.start()
    return async () => {
      stopChange()
      await runtime.dispose()
    }
  }, 'cron.lifecycle()')

  // Register the management tools on every root agent published after load.
  // Run agents spawned for cron jobs (sessions named `cron-<jobId>-<occurrence>`)
  // are intentionally excluded: their task prompt is untrusted content, and the
  // job table must not be reachable from inside a run (a confused run agent has
  // deleted and recreated jobs it was never asked to touch).
  ctx.on('agent/created', ({ agent }) => {
    if (!storeLoaded || ctx.agents.roots().includes(agent) === false) return
    if (isCronRunSession(agent.session?.id)) return
    agent.ctx.effect(() => registerCronTools(ctx, agent.ctx, runtime, config), 'cron.tools()')
  })

  // Browser bridge (REST + SSE) for the P1 client UI. No-op when the harness
  // does not mount a web server (e.g. headless profiles).
  if (storeLoaded) {
    ctx.effect(() => registerCronApi(ctx, runtime, config), 'cron.api()')
  }
}

/** Whether a session id belongs to a cron run agent (`cron-<jobId>-<occurrence>`). */
function isCronRunSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('cron-')
}
