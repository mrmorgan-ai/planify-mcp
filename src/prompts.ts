// Prompts an agent can offer the person it works with. A prompt carries no
// data and calls nothing: it is the method, and the tools do the work. It lives
// here, not in a skill each person installs, so every client of this server —
// and every person it serves — gets the same one, and a change to it reaches
// them all at once.

export type PromptArgument = { name: string; description: string; required: boolean }

export type Prompt = {
  name: string
  title: string
  description: string
  arguments: PromptArgument[]
  /** The prompt's text, from arguments already checked against `arguments`. */
  render: (args: Record<string, string>) => string
}

/** A prompt asked for with arguments it cannot take; the message is what the agent reads. */
export class PromptError extends Error {}

const PLAN_FROM_SPEC: Prompt = {
  name: 'plan_from_spec',
  title: 'Turn a goal into a plan',
  description:
    'Walks through turning what a person wants to achieve into a Planify roadmap they can follow: outcome and proof, hours, a skill map, phases that each end in something built, units sized in weeks, then placed in a draft and reviewed before it is published. For a new or empty roadmap, or a new phase.',
  arguments: [
    {
      name: 'goal',
      description:
        'What the person wants to achieve, in their own words: a sentence, or a whole spec pasted in.',
      required: true,
    },
    {
      name: 'constraints',
      description:
        'What is already known about their time: hours a week, start date, deadline, weeks off.',
      required: false,
    },
  ],
  render: ({ goal, constraints }) => `You are turning a person's goal into a Planify roadmap they can actually follow. The roadmap is theirs: ask before you assume, and change nothing until they have seen the plan and agreed to it.

The goal, in their words:
<goal>
${goal}
</goal>
${
  constraints
    ? `
What they said about their time:
<constraints>
${constraints}
</constraints>
`
    : ''
}
Work in six steps. Finish each before the next, and show the person what it produced.

1. Outcome and proof. Restate the goal as one sentence of what they will be able to do, and how someone else could check it: a thing built, a number measured, an exam passed. If the goal is vague, ask until it is not. That proof is the closing milestone of the last phase.

2. Budget. Ask for what is missing of: hours they can study each week, the date they start, weeks they cannot study (holidays, travel, a birth), and the date they want to be done by. Hours a week times weeks is the budget. When the goal does not fit it, say so, and cut scope or move the date together. Never plan more hours a week than they gave.

3. Skill map. Read get_roadmap first. Propose four to six axes for this goal and two to five concrete skills under each; they replace whatever the roadmap starts with. Every item names the skills it trains, so choose skills you could point at in their work, not topics.

4. Phases. At most six. Each ends in something built or measured, and that is its closing milestone: an exam, or the last task of the phase's project, usually a write-up that argues its decisions with numbers from the earlier tasks. A phase with nothing to show is folded into another.

5. Units. For each phase, choose the courses, books, documentation, projects, exams and practice that get there, naming exact chapters, modules or tasks, never "read the docs of X". Estimate each in hours. A project that runs through the phase and applies what is studied as it goes beats reading alone. Each week gets one practice block that applies that week's material hands-on, and its done-when is something checkable ("the benchmark table is written and explained"), never an activity ("practice X").

6. Place, review, publish. start_draft, then every write with draft: true and a dry run first:
   - apply_edits: setSkillMap; updateSettings with timeZone, startDate and weeklyHours; setBlackouts; updatePhase and addPhase for the phases' names.
   - generate, once per unit: course (hours in all, weeklyHours as the pace), certification (prepHours, examHours, examDate), project (tasks with their hours), practice (hours a block, weeks). Generators place work in the hours each week has free, one week at most per item, chained.
   - apply_edits for what the generators do not make, and updatePhase to set each phase's closingMilestoneId.
   Then validate with draft: true. Fix every error, and fix or explain every warning. Show the person the plan phase by phase (list_items with draft: true), with total hours against the budget. Publish only when they agree: publish_draft as a dry run, then for real.

What Planify holds a plan to: an item lasts at most seven study days, inside one week; nothing starts or ends in a pause; no week is planned above its capacity; dependencies are real relationships (the next part of a course waits on the previous part, a project task on the one before, a phase on the previous phase's closing milestone), never "everything in order"; and a dependency ends before the item that waits on it starts. Progress is the person's: never mark anything done or log hours.`,
}

export const PROMPTS: Prompt[] = [PLAN_FROM_SPEC]

/** A prompt's text, from the arguments an agent sent, checked against what it takes. */
export function renderPrompt(name: unknown, args: unknown): { prompt: Prompt; text: string } {
  const prompt = PROMPTS.find((each) => each.name === name)
  if (!prompt) throw new PromptError(`No such prompt: ${String(name)}`)

  const given = args === undefined || args === null ? {} : args
  if (typeof given !== 'object' || Array.isArray(given)) {
    throw new PromptError('arguments must be an object')
  }
  const values: Record<string, string> = {}
  for (const argument of prompt.arguments) {
    const value = (given as Record<string, unknown>)[argument.name]
    if (value === undefined || value === null || value === '') {
      if (argument.required) throw new PromptError(`${argument.name} is required`)
      continue
    }
    if (typeof value !== 'string') throw new PromptError(`${argument.name} must be a string`)
    values[argument.name] = value
  }
  return { prompt, text: prompt.render(values) }
}
