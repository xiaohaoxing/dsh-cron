/**
 * Model-facing management tools for @dsh/cron.
 *
 * Registered per root agent (same pattern as `@deepseek-ai/dsh-schedule`'s
 * `registerScheduleTools`). Cron jobs are global, so the tools are not bound
 * to one agent — any root agent may create/update/delete any job.
 *
 * Every mutation goes through the shared service layer (`service.js`), the
 * same code path the browser REST API uses. The tools only map service
 * results to tool output shapes and emit `cron/change`.
 *
 * Closed-union error codes: invalid_expression, invalid_time_zone,
 * invalid_target, invalid_prompt, invalid_id, not_found, persistence_uncertain,
 * internal_error.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createJob, deleteJob, listViews, pauseJob, resumeJob, updateJob } from './service.js'

function basicErrorSchema(code) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  }
}

const BASIC_ERROR_SCHEMAS = [
  basicErrorSchema('invalid_expression'),
  basicErrorSchema('invalid_time_zone'),
  basicErrorSchema('invalid_target'),
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('invalid_id'),
  basicErrorSchema('not_found'),
  basicErrorSchema('persistence_uncertain'),
  basicErrorSchema('internal_error'),
]

const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['new-chat', 'existing-chat'] },
    sessionId: { type: 'string' },
    project: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    reasoningEffort: { type: 'string', enum: ['off', 'high', 'max'] },
    permissionMode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
  },
}

/**
 * Tool-argument variant of the target: permissionMode additionally accepts
 * null as the explicit "clear" marker (remove the pin, inherit the deployment
 * default). Views never contain null — the store drops it — so the shared
 * TARGET_SCHEMA keeps the plain string enum for output validation.
 */
const TARGET_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...TARGET_SCHEMA.properties,
    permissionMode: { oneOf: [{ type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] }, { type: 'null' }] },
  },
}

const SCHEDULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    expression: { type: 'string', required: true },
    timezone: { type: 'string' },
  },
}

const HISTORY_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runAt: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['ok', 'failed', 'skipped'] },
    sessionId: { type: 'string' },
    error: { type: 'string' },
  },
}

const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    enabled: { type: 'boolean', required: true },
    schedule: { type: 'object', required: true, properties: SCHEDULE_SCHEMA.properties, additionalProperties: false },
    target: { type: 'object', required: true, properties: TARGET_SCHEMA.properties, additionalProperties: false },
    notification: { type: 'object', required: true, properties: { mode: { type: 'string', required: true, const: 'session' } }, additionalProperties: false },
    nextRunAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    lastRunAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    state: { type: 'string', required: true, enum: ['scheduled', 'overdue', 'disabled'] },
    runHistory: { type: 'array', required: true, items: HISTORY_ENTRY_SCHEMA },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
}

const CREATE_OUTPUT_SCHEMA = { oneOf: [VIEW_SCHEMA, ...BASIC_ERROR_SCHEMAS] }
const LIST_OUTPUT_SCHEMA = { oneOf: [{ type: 'array', items: VIEW_SCHEMA }, ...BASIC_ERROR_SCHEMAS] }
const DELETE_OUTPUT_SCHEMA = { oneOf: [
  { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, deleted: { type: 'boolean', required: true, const: true } } },
  { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, deleted: { type: 'boolean', required: true, const: false }, code: { type: 'string', required: true, const: 'not_found' } } },
  ...BASIC_ERROR_SCHEMAS,
] }

const CREATE_DESCRIPTION = 'Create one cron job in the global scheduled-task table. Supply a non-empty prompt and a 5-field cron expression (minute hour day-of-month month day-of-week; supports `*`, `*/n`, `a-b`, `a,b`, `?`, and JAN..DEC / SUN..SAT names). Timezone defaults to the plugin default. target.kind selects where each run executes: new-chat (a fresh agent session per run, default) or existing-chat (deliver into the live or persisted session identified by target.sessionId). Optionally bind the run workspace with target.project (absolute path), and pin provider/model/reasoningEffort. target.permissionMode (read-only | workspace-write | danger-full-access) pins the sandbox permission mode of every run session; omit it or pass null to inherit the deployment default. For existing-chat targets the mode is written into the target session (it persists there); for new-chat targets it applies to each fresh run session.'
const LIST_DESCRIPTION = 'List every cron job in creation order with its schedule, target, enabled state, next/last run, and recent run history.'
const UPDATE_DESCRIPTION = 'Update one cron job by id. Any supplied field replaces that part of the job: title, prompt, schedule (expression/timezone), target (including permissionMode), notification, or enabled. target.permissionMode accepts read-only | workspace-write | danger-full-access, or null to clear the pin so runs inherit the deployment default again (omitting it keeps the current mode). Changing the schedule recomputes nextRunAt from now; re-enabling an overdue job also recomputes it.'
const DELETE_DESCRIPTION = 'Delete one cron job by id. Unknown ids return deleted false with code not_found.'
const PAUSE_DESCRIPTION = 'Pause one cron job by id (enabled=false). It stops firing but keeps its schedule and history.'
const RESUME_DESCRIPTION = 'Resume one paused cron job by id (enabled=true). If it was overdue, nextRunAt is recomputed from now (missed occurrences are not run).'

function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function present(title, kind, rawInput) {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Register all cron tools on `toolCtx`. Returns an idempotent disposer.
 * @param {import('@deepseek-ai/cordis').Context} rootCtx - global service context.
 * @param {import('@deepseek-ai/cordis').Context} toolCtx - agent-scoped context receiving the tools.
 * @param {import('./runtime.js').CronRuntime} runtime - scheduler runtime.
 * @param {{ timezone?: string }} [defaults]
 */
export function registerCronTools(rootCtx, toolCtx, runtime, defaults = {}) {
  const disposers = []
  const logger = rootCtx.logger
  const notifyChange = () => {
    try {
      rootCtx.emit('cron/change')
    } catch (error) {
      logger.warn(`cron: change observer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        prompt: { type: 'string', required: true, description: 'Task content executed at every occurrence.' },
        title: { type: 'string', description: 'Optional short title; defaults to a human label derived from the expression.' },
        schedule: { type: 'object', required: true, properties: SCHEDULE_SCHEMA.properties, additionalProperties: false, description: '5-field cron expression and optional IANA timezone.' },
        target: { type: 'object', properties: TARGET_INPUT_SCHEMA.properties, additionalProperties: false, description: 'Where each run executes.' },
        notification: { type: 'object', properties: { mode: { type: 'string', const: 'session' } }, additionalProperties: false },
      },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        const result = createJob(runtime, defaults, args, logger)
        if (result.ok) {
          notifyChange()
          return result.view
        }
        return result.error
      },
      presentCall: (args) => present('Create cron job', 'other', typeof args.title === 'string' ? args.title : args.prompt),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
      async execute() {
        return listViews(runtime)
      },
      presentCall: () => present('List cron jobs', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_update',
      description: UPDATE_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact cron job id.' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        schedule: { type: 'object', properties: SCHEDULE_SCHEMA.properties, additionalProperties: false },
        target: { type: 'object', properties: TARGET_INPUT_SCHEMA.properties, additionalProperties: false },
        notification: { type: 'object', properties: { mode: { type: 'string', const: 'session' } }, additionalProperties: false },
        enabled: { type: 'boolean' },
      },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        const result = updateJob(runtime, args.id, args, logger)
        if (result.ok) {
          notifyChange()
          return result.view
        }
        return result.error
      },
      presentCall: (args) => present('Update cron job', 'other', args.id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_delete',
      description: DELETE_DESCRIPTION,
      parameters: { id: { type: 'string', required: true, description: 'Exact cron job id.' } },
      output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        const result = deleteJob(runtime, args.id, logger)
        if (result.ok) {
          notifyChange()
          return result.result
        }
        return result.error
      },
      presentCall: (args) => present('Delete cron job', 'other', args.id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_pause',
      description: PAUSE_DESCRIPTION,
      parameters: { id: { type: 'string', required: true, description: 'Exact cron job id.' } },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        const result = pauseJob(runtime, args.id, logger)
        if (result.ok) {
          notifyChange()
          return result.view
        }
        return result.error
      },
      presentCall: (args) => present('Pause cron job', 'other', args.id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'cron_resume',
      description: RESUME_DESCRIPTION,
      parameters: { id: { type: 'string', required: true, description: 'Exact cron job id.' } },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        const result = resumeJob(runtime, args.id, logger)
        if (result.ok) {
          notifyChange()
          return result.view
        }
        return result.error
      },
      presentCall: (args) => present('Resume cron job', 'other', args.id),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
