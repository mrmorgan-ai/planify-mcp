// The part of planify's API this server reads. The contract is planify's HTTP
// API, not its code: these mirror what its endpoints answer (planify's
// src/core/types.ts, validate.ts and importing.ts), and only the fields used here.

export type State = 'pending' | 'in_progress' | 'done'

export type Item = {
  id: string
  name: string
  type: string
  phase: number
  skills: string[]
  workItemId: string | null
  baselineStartDate: string
  baselineEndDate: string
  projectedStartDate: string
  projectedEndDate: string
  dependsOn: string[]
  price: string
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

export type WorkItem = { id: string; name: string; type: string }

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
  workItems: WorkItem[]
  items: Item[]
}

export type Issue = {
  severity: 'error' | 'warning'
  rule: string
  message: string
  itemId: string | null
}

/** What every `dryRun` answers. */
export type Preview = {
  revision: number
  changes: {
    items: {
      added: string[]
      removed: Array<{ id: string; name: string; state: State; hoursDone: number }>
      changed: Array<{ id: string; fields: string[] }>
    }
    workItems: { added: string[]; removed: string[]; changed: string[] }
    settings: string[]
  }
  introduced: Issue[]
  issues: Issue[]
}
