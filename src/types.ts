// The part of planify's API this server reads. The contract is planify's HTTP
// API, not its code: these mirror what its endpoints answer (planify's
// src/core/types.ts, validate.ts and importing.ts), and only the fields used here.

export type State = 'pending' | 'in_progress' | 'done'

/** One scheduled step, inside a week. Its phase is its story's. */
export type Task = {
  id: string
  name: string
  phase: number
  skills: string[]
  storyId: string
  baselineStartDate: string
  baselineEndDate: string
  projectedStartDate: string
  projectedEndDate: string
  dependsOn: string[]
  link: string | null
  resources: Array<{ label: string; url: string }>
  duration: string
  notes: string
  doneWhen: string
  state: State
  completedAt: string | null
  hoursDone: number
  sortOrder: number
}

/** A deliverable inside one phase, made of tasks. */
export type Story = {
  id: string
  name: string
  /** An optional label: Course, Certification, Project… */
  type: string | null
  phase: number
  featureId: string | null
  price: string
  doneWhen: string
}

/** A goal wider than a phase, served by stories. */
export type Feature = { id: string; name: string; type: string | null }

export type Phase = { number: number; name: string; closingMilestoneId: string | null }

export type Roadmap = {
  timeZone: string
  startDate: string
  weeklyHours: { normal: number }
  phases: Phase[]
  blackouts: Array<{ from: string; to: string; reason: string }>
  dimensions: string[]
  skillDimension: Record<string, string>
}

/** `GET /api/state` and `GET /api/draft`: the whole world. */
export type AppState = {
  today: string
  revision: number
  draft: { startedAt: string; updatedAt: string } | null
  roadmap: Roadmap
  features: Feature[]
  stories: Story[]
  tasks: Task[]
}

export type Issue = {
  /** A note is a convention a sound plan may not follow: told, never a problem. */
  severity: 'error' | 'warning' | 'info'
  rule: string
  message: string
  taskId: string | null
}

type Changed = { added: string[]; removed: string[]; changed: string[] }

/** What every `dryRun` answers. */
export type Preview = {
  revision: number
  changes: {
    tasks: {
      added: string[]
      removed: Array<{ id: string; name: string; state: State; hoursDone: number }>
      changed: Array<{ id: string; fields: string[] }>
    }
    stories: Changed
    features: Changed
    settings: string[]
  }
  introduced: Issue[]
  issues: Issue[]
}
