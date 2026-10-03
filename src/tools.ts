import type { Planify } from './planify'
import type { AppState, Issue, Preview, Task } from './types'

// What an agent can do to the roadmap, as MCP tools. Each one is a call to
// planify's own API, so an agent's change is checked, guarded by revision and
// kept in the history exactly like one made in the app.
//
// Answers are kept small on purpose: an agent pays for every token it reads.
// planify answers a write with the whole world; the agent gets the new revision.

/** A call refused before it reaches planify; its message is what the agent reads. */
export class ToolError extends Error {}

type Args = Record<string, unknown>
type Target = 'live' | 'draft'

export type Tool = {
  name: string
  title: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  annotations: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint: false
  }
  run: (args: Args, planify: Planify) => Promise<unknown>
}

const draftFlag = {
  type: 'boolean',
  description: 'Work on the draft instead of the live roadmap. Default false.',
}
const dryRunFlag = {
  type: 'boolean',
  description: 'Preview what it would change and the rules it would break, writing nothing.',
}
const revisionArg = {
  type: 'integer',
  description:
    'The revision this change was made from, as the last read answered — the draft’s when draft is true. A stale one is refused.',
}

const WORK_TYPES =
  'Certification, Course, Book, Documentation, Paper, Case study, Project, Practice, Exam prep'

const EDITS_HELP = `A task is one step that fits in a week. Every task is a step of a story — a deliverable inside one phase — and takes its story's phase; a story may serve a feature, a goal wider than a phase. Each edit is an object with an "op":
- updateTask {id, fields} — fields: name, storyId (moving it to that story's phase, last), skills, link, resources [{label,url}], duration ("~6h, 3 chapters"), notes, doneWhen
- setDependencies {id, dependsOn: [ids]}
- createTask {task: {name, storyId, baselineStartDate, baselineEndDate, skills, id?, dependsOn?, duration, notes, doneWhen, link, resources}}
- moveTask {id, before?: task id} — order within its phase; a task changes phase by changing story
- deleteTask {id, rewire?: connect its dependents to its dependencies, discardProgress?}
- createStory {story: {name, phase, id?, type?, featureId?, link, resources, price, notes, doneWhen}}, updateStory {id, fields} (a new phase moves its tasks with it), deleteStory {id} (only once it has no tasks)
- createFeature {feature: {name, id?, type?, link, notes}}, updateFeature {id, fields}, deleteFeature {id} (its stories stay, serving none)
- addPhase {name}, updatePhase {number, fields: {name?, closingMilestoneId?}}, removePhase {number} (the last, once it has no stories)
- setBlackouts {blackouts: [{from, to, reason}], keepStudyDays?: shift unfinished tasks with the pauses}
- updateSettings {fields: {timeZone?, startDate?, weeklyHours?}}
- setSkillMap {dimensions, skills: {skill: dimension}, renamed?: {old: new}}
A type is an optional label on stories and features, one of: ${WORK_TYPES}. Tasks have none. Dates are YYYY-MM-DD. Dates of an existing task move with move_task, not here.`

const GENERATOR_HELP = `An object with "kind" and, for every kind: name, phase, skills (at least one), after (a task id the first new task waits on, or null for the previous phase's closing milestone), from ("" or the earliest YYYY-MM-DD). Then:
- course: type (Course | Book | Documentation), link, hours (in all), weeklyHours (the most a week) — a task a week, each holding what the week has free
- certification: link, price, prepHours (0 for none), weeklyHours, prepDoneWhen, examHours, examDate ("" for the first day with room)
- project: link, doneWhen (for the whole project), tasks [{name, hours}] — chained, each where its hours fit
- practice: hours (a block), weeks, doneWhen — one block a week, at the end of the week
Each makes one new story, its tasks placed in the hours the weekly capacity leaves free, inside one week each, skipping pauses.`

export const TOOLS: Tool[] = [
  {
    name: 'get_roadmap',
    title: 'Roadmap overview',
    description:
      'Start here. Today, the revision to write from, capacity, phases with their dates and task counts, pauses, features, stories with their phase and task counts, the skill map, and whether a draft is in progress. Tasks come from list_tasks; what the plan breaks, from validate.',
    inputSchema: { type: 'object', properties: { draft: draftFlag }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, planify) => overview(await world(planify, target(args)), target(args)),
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description:
      'Tasks in plan order, with planned and projected dates, duration, state, hours done, dependencies and story. Filter by phase, story and state to keep the answer small; full adds notes, done-when and links.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'integer', description: 'Only this phase.' },
        story: { type: 'string', description: 'Only the tasks of this story id.' },
        state: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        full: { type: 'boolean', description: 'Every field, not only the planning ones.' },
        draft: draftFlag,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, planify) => {
      const state = await world(planify, target(args))
      const phase = optionalInteger(args.phase, 'phase')
      const story = optionalString(args.story, 'story')
      const wanted = optionalString(args.state, 'state')
      return {
        revision: state.revision,
        tasks: state.tasks
          .filter((task) => phase === null || task.phase === phase)
          .filter((task) => story === null || task.storyId === story)
          .filter((task) => wanted === null || task.state === wanted)
          .sort((a, b) => a.phase - b.phase || a.sortOrder - b.sortOrder)
          .map((task) => (args.full === true ? fullTask(task) : planningTask(task))),
      }
    },
  },
  {
    name: 'export_roadmap',
    title: 'Export the roadmap file',
    description:
      'The whole live roadmap as the file the app exports and imports: settings, phases, pauses, skills, features, stories and every task, without progress. Large; prefer get_roadmap and list_tasks for reading. Edit it and pass it to import_roadmap to change many things at once.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (_args, planify) => planify('GET', '/api/export'),
  },
  {
    name: 'validate',
    title: 'Check the plan',
    description:
      'Every rule the plan breaks. Errors refuse a write to the live roadmap; warnings are the plan’s conventions (a week over capacity, a task over a week long) and never block; notes are conventions a sound plan may skip (a story of one task) and are not problems.',
    inputSchema: { type: 'object', properties: { draft: draftFlag }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, planify) => {
      const path = target(args) === 'draft' ? '/api/issues?draft=1' : '/api/issues'
      const { revision, issues } = (await planify('GET', path)) as {
        revision: number
        issues: Issue[]
      }
      return { revision, ...countOf(issues), issues: issues.map(issueOf) }
    },
  },
  {
    name: 'apply_edits',
    title: 'Edit the plan',
    description: `Applies a list of edits as one change: all of it or none. Dry-run first. ${EDITS_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        revision: revisionArg,
        edits: { type: 'array', items: { type: 'object' }, minItems: 1 },
        dryRun: dryRunFlag,
        draft: draftFlag,
      },
      required: ['revision', 'edits'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: false },
    run: (args, planify) => {
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        throw new ToolError('edits must be a non-empty array')
      }
      return write(planify, args, 'POST', '/api/edits', { edits: args.edits })
    },
  },
  {
    name: 'move_task',
    title: 'Move a task’s dates',
    description:
      'Sets a task’s planned start and end. When it now ends later, everything that depends on it moves forward by the same study days. Nothing is pulled back.',
    inputSchema: {
      type: 'object',
      properties: {
        revision: revisionArg,
        id: { type: 'string' },
        start: { type: 'string', description: 'YYYY-MM-DD' },
        end: { type: 'string', description: 'YYYY-MM-DD' },
        dryRun: dryRunFlag,
        draft: draftFlag,
      },
      required: ['revision', 'id', 'start', 'end'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: false },
    run: (args, planify) =>
      write(
        planify,
        args,
        'PATCH',
        `/api/tasks/${encodeURIComponent(requiredString(args.id, 'id'))}/dates`,
        {
          baselineStartDate: requiredString(args.start, 'start'),
          baselineEndDate: requiredString(args.end, 'end'),
        },
      ),
  },
  {
    name: 'generate',
    title: 'Generate and place a story',
    description: `Adds a course, certification, project or practice blocks as a story with its tasks, placed in the plan. Dry-run first: the answer lists each new task with its dates. ${GENERATOR_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        revision: revisionArg,
        generator: { type: 'object' },
        dryRun: dryRunFlag,
        draft: draftFlag,
      },
      required: ['revision', 'generator'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, openWorldHint: false },
    run: (args, planify) =>
      write(planify, args, 'POST', '/api/generate', { generator: args.generator }),
  },
  {
    name: 'import_roadmap',
    title: 'Import a roadmap file',
    description:
      'Replaces the live roadmap’s content with a file shaped like export_roadmap’s. Progress on the tasks it keeps stays; tasks it drops go with their progress. Dry-run first and read what it removes.',
    inputSchema: {
      type: 'object',
      properties: {
        revision: revisionArg,
        roadmap: { type: 'object', description: 'The file, as export_roadmap answers it.' },
        dryRun: dryRunFlag,
      },
      required: ['revision', 'roadmap'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: false },
    run: (args, planify) => {
      const { revision: _named, ...file } = objectArg(args.roadmap, 'roadmap')
      return write(planify, { ...args, draft: false }, 'POST', '/api/import', { roadmap: file })
    },
  },
  {
    name: 'start_draft',
    title: 'Start or open the draft',
    description:
      'A draft is a copy of the plan to change freely, including through states that break rules; the live roadmap is untouched until publish_draft. Starts one from the live plan, or opens the one in progress. There is one at a time, shared with the app. Then pass draft: true to the other tools, with the draft’s revision.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (_args, planify) =>
      overview((await planify('POST', '/api/draft')) as AppState, 'draft'),
  },
  {
    name: 'publish_draft',
    title: 'Publish the draft',
    description:
      'Makes the draft the plan in one change, keeping the live roadmap’s progress, and ends the draft. Dry-run first with draftRevision alone: the answer says what it changes on the live roadmap, whether the live plan changed since the draft started, and the live revision to publish from. Refused if it would bring in an error.',
    inputSchema: {
      type: 'object',
      properties: {
        draftRevision: { type: 'integer', description: 'The draft’s revision, as reviewed.' },
        revision: {
          type: 'integer',
          description: 'The live revision the dry run answered. Needed to publish.',
        },
        dryRun: dryRunFlag,
      },
      required: ['draftRevision'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: false },
    run: async (args, planify) => {
      const draftRevision = integerArg(args.draftRevision, 'draftRevision')
      if (args.dryRun === true) {
        const answer = (await planify('POST', '/api/draft/publish', {
          draftRevision,
          dryRun: true,
        })) as Preview & { liveChanged: boolean }
        return { ...preview(answer), liveChanged: answer.liveChanged }
      }
      const after = (await planify('POST', '/api/draft/publish', {
        draftRevision,
        revision: integerArg(args.revision, 'revision'),
      })) as AppState
      return { published: true, revision: after.revision, target: 'live' }
    },
  },
  {
    name: 'discard_draft',
    title: 'Discard the draft',
    description: 'Drops the draft and every change in it. The live roadmap is untouched.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (_args, planify) => {
      const live = (await planify('DELETE', '/api/draft')) as AppState
      return { discarded: true, revision: live.revision }
    },
  },
]

function world(planify: Planify, where: Target): Promise<AppState> {
  return planify('GET', where === 'draft' ? '/api/draft' : '/api/state') as Promise<AppState>
}

/**
 * A write, or its dry run: the arguments every write shares go in the body as
 * planify's API names them. A dry run answers planify's preview, compacted; a
 * write, the new revision.
 */
async function write(
  planify: Planify,
  args: Args,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const dryRun = args.dryRun === true
  const where = target(args)
  const answer = await planify(method, path, {
    ...body,
    revision: integerArg(args.revision, 'revision'),
    draft: where === 'draft',
    dryRun,
  })
  if (dryRun) {
    const { placed } = answer as { placed?: unknown }
    return { ...preview(answer as Preview), ...(placed === undefined ? {} : { placed }) }
  }
  return { applied: true, revision: (answer as AppState).revision, target: where }
}

/** A preview, with the issues it leaves counted rather than listed. */
function preview({ revision, changes, introduced, issues }: Preview) {
  return {
    dryRun: true,
    revision,
    changes,
    introducedErrors: introduced.map(issueOf),
    ...countOf(issues),
  }
}

function countOf(issues: readonly Issue[]) {
  return {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    notes: issues.filter((issue) => issue.severity === 'info').length,
  }
}

function issueOf(issue: Issue) {
  return {
    severity: issue.severity,
    rule: issue.rule,
    message: issue.message,
    taskId: issue.taskId,
  }
}

function overview(state: AppState, where: Target) {
  const { roadmap, tasks, stories, features } = state
  return {
    target: where,
    today: state.today,
    revision: state.revision,
    draftInProgress: state.draft,
    timeZone: roadmap.timeZone,
    startDate: roadmap.startDate,
    weeklyHours: roadmap.weeklyHours.normal,
    phases: roadmap.phases.map((phase) => {
      const inPhase = tasks.filter((task) => task.phase === phase.number)
      return {
        number: phase.number,
        name: phase.name,
        closingMilestoneId: phase.closingMilestoneId,
        tasks: inPhase.length,
        done: inPhase.filter((task) => task.state === 'done').length,
        plannedStart: earliest(inPhase.map((task) => task.baselineStartDate)),
        plannedEnd: latest(inPhase.map((task) => task.baselineEndDate)),
      }
    }),
    pauses: roadmap.blackouts,
    features: features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      type: feature.type,
      stories: stories.filter((story) => story.featureId === feature.id).length,
    })),
    stories: stories.map((story) => {
      const steps = tasks.filter((task) => task.storyId === story.id)
      return {
        id: story.id,
        name: story.name,
        type: story.type,
        phase: story.phase,
        featureId: story.featureId,
        tasks: steps.length,
        done: steps.filter((task) => task.state === 'done').length,
      }
    }),
    dimensions: roadmap.dimensions,
    skills: roadmap.skillDimension,
  }
}

function planningTask(task: Task) {
  return {
    id: task.id,
    name: task.name,
    phase: task.phase,
    storyId: task.storyId,
    start: task.baselineStartDate,
    end: task.baselineEndDate,
    // Only where the projection has moved off the plan.
    ...(task.projectedStartDate !== task.baselineStartDate ||
    task.projectedEndDate !== task.baselineEndDate
      ? { projectedStart: task.projectedStartDate, projectedEnd: task.projectedEndDate }
      : {}),
    duration: task.duration,
    state: task.state,
    hoursDone: task.hoursDone,
    dependsOn: task.dependsOn,
    skills: task.skills,
  }
}

function fullTask(task: Task) {
  return {
    ...planningTask(task),
    notes: task.notes,
    doneWhen: task.doneWhen,
    link: task.link,
    resources: task.resources,
    completedAt: task.completedAt,
  }
}

function earliest(dates: string[]): string | null {
  return dates.reduce<string | null>((min, date) => (min === null || date < min ? date : min), null)
}

function latest(dates: string[]): string | null {
  return dates.reduce<string | null>((max, date) => (max === null || date > max ? date : max), null)
}

function target(args: Args): Target {
  return args.draft === true ? 'draft' : 'live'
}

function integerArg(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ToolError(`${name} must be a whole number`)
  }
  return value
}

function optionalInteger(value: unknown, name: string): number | null {
  return value === undefined || value === null ? null : integerArg(value, name)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new ToolError(`${name} must be a string`)
  return value
}

function optionalString(value: unknown, name: string): string | null {
  return value === undefined || value === null ? null : requiredString(value, name)
}

function objectArg(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}
