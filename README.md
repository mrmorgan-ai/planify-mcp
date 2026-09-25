# Planify MCP

[Planify](https://github.com/mrmorgan-ai/planify)'s roadmap as an MCP server. Claude Code, Codex or any MCP client can read the plan, change it and place new work in it, through the same checks, revisions and history as the app.

The question it answers is "can an agent replan this with me?" rather than "how
do I get this JSON in and out?".

## What it does

- **Reads the plan small.** An overview first — today, phases, capacity, pauses,
  work items, skills — then only the items asked for, by phase or state. The
  whole roadmap file is there too, but an agent rarely needs it.
- **Previews before it writes.** Every write has a dry run that says what it
  would change, the rules it would break and the warnings it would leave. Nothing
  is written until the agent asks again without it.
- **Never overwrites unseen.** Every write names the revision it was read at. If
  the roadmap changed in between — in the app, on another device — it is
  refused, and the agent reads again.
- **Keeps the plan sound.** A write that brings in an error is refused with the
  rules it breaks. Warnings, like a week over capacity, are reported and never
  block.
- **Stages big changes in a draft.** Several steps go into a draft, which may pass
  through broken states, and are published as one change after a review of what
  it does to the live roadmap.
- **Places new work.** A course, a certification, a project or practice blocks
  are described in a few fields and placed in the hours the weekly capacity
  leaves free, skipping pauses.
- **Leaves progress alone.** Ticking items off and logging hours stay with the
  person, in the app.
- **Serves each person their own roadmap.** Whoever signs in reaches their
  roadmap and no one else's.
- **Brings the method along.** The `plan_from_spec` prompt walks an agent through
  turning what someone wants to achieve into a plan they can follow.

Every change an agent makes shows up in the app's history, and can be undone
there like any other.

## The tools

| Tool | What it is for |
|---|---|
| `get_roadmap` | Start here: today, the revision to write from, capacity, phases with their dates, pauses, work items, the skill map, and whether a draft is in progress |
| `list_items` | Items in plan order with their dates, duration, state, hours and dependencies, filtered by phase and state; `full` adds notes, links and price |
| `validate` | Every rule the plan breaks, errors and warnings |
| `export_roadmap` | The whole roadmap file, as the app exports it |
| `apply_edits` | Edit items, work items, phases, pauses, settings or skills as one change |
| `move_item` | Move an item's planned dates; what depends on it moves forward with it |
| `generate` | Add a course, certification, project or practice blocks, placed in the free hours |
| `import_roadmap` | Replace the roadmap with a file, keeping progress on the items it keeps |
| `start_draft` | Start a draft of the plan, or open the one in progress |
| `publish_draft` | Review the draft against the live roadmap, then make it the plan |
| `discard_draft` | Drop the draft |

The writes take `revision` and `dryRun`; the ones that shape the plan also take
`draft`, to work on the draft instead.

A typical session: `get_roadmap`, `list_items` for the phase in question, a
change with `dryRun`, then the same change for real. For a larger replan:
`start_draft`, the changes with `draft: true`, then `publish_draft` — dry run
first.

## The prompt

`plan_from_spec` takes a `goal` — a sentence, or a whole spec pasted in — and
optionally `constraints`, what is known about the person's time. It is the
method for a new roadmap, or a new phase, in six steps:

1. **Outcome and proof.** One sentence of what they will be able to do, and how
   someone else could check it. That proof closes the last phase.
2. **Budget.** Hours a week, start date, weeks off, deadline. When the goal does
   not fit, scope or the date moves, never the hours.
3. **Skill map.** Four to six axes and a few concrete skills under each.
4. **Phases.** At most six, each ending in something built or measured.
5. **Units.** Courses, books, projects, exams and weekly practice, named
   exactly, sized in hours, none longer than a week.
6. **Place, review, publish.** In a draft, with the generators placing the units
   in the free hours, validated, shown to the person, and published only when
   they agree.

The prompt guides; the tools do the work, and nothing reaches the live roadmap
until the person agrees.

## Limits

Each person gets 1,000 tool calls a day, and the server 2,000 in all. Past
either, calls are refused until 00:00 UTC. Prompts do not count.

## Connect

You need an invitation first: whoever runs your Planify adds your email and
gives you a roadmap. Then you sign in with that email. There is no key or
password to keep.

### Claude Code

```sh
claude mcp add --transport http planify https://<planify-mcp host>/mcp
```

Start a session, run `/mcp`, choose `planify` and then **Authenticate**. Your
browser opens a sign-in page: enter your email, then the code it sends you. Back
in Claude Code, `planify` shows as connected. The sign-in lasts a few hours, and
Claude Code renews it; when it cannot, `/mcp` asks you to sign in again.

### Codex and other clients

Any MCP client that speaks Streamable HTTP and supports OAuth sign-in connects
with just the address, `https://<planify-mcp host>/mcp`, and opens the same
browser sign-in. The server answers protocol versions 2025-06-18, 2025-03-26
and 2024-11-05.

### Scripts and CI

A script cannot sign in with a browser. It uses a service token instead, a
client id and secret sent as the `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers on every request. Ask whoever runs your
Planify for one. Keep it out of any tracked file.

## Use it

Start with a question, not a command. The agent reads the plan first and
decides which tools it needs.

> What is on my roadmap this week, and am I over capacity anywhere?

> Move the Kubernetes phase two weeks later and show me what else that pushes.

> I want to pass the CKA by June. Use `plan_from_spec` and build me a plan.

What to expect:

- **Nothing changes until you agree.** Every write is first shown as a dry run:
  what it would change, the rules it would break, the warnings it would leave.
  Read that, then tell the agent to go ahead.
- **Small changes go straight in.** Moving an item, or editing a note, is one
  change through `move_item` or `apply_edits`.
- **Big changes go through a draft.** A replan is built in a draft, checked with
  `validate`, and published as one change with `publish_draft`. `discard_draft`
  drops it, and the live roadmap is untouched.
- **A stale write is refused.** If you edited the plan in the app while the agent
  worked, the agent is told to read again and retry. It cannot overwrite what it
  has not seen.
- **Everything is undoable.** Each change shows up in the app's history, where you
  can undo it like any other.
- **Progress stays yours.** The agent will not tick items off or log hours. Do
  that in the app.
- **Only your roadmap.** The server acts for whoever signed in, and planify
  answers with that person's roadmap and no one else's.

To start a new plan, ask for the prompt by name. In Claude Code it is
`/mcp__planify__plan_from_spec`, and it asks for your goal. Any client that lists
MCP prompts offers `plan_from_spec` the same way.

### Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| The sign-in page does not accept your email | You are not invited to this server | Ask whoever runs your Planify to add your email |
| "There is no roadmap for" your email | You signed in, but no roadmap is yours yet | Ask whoever runs your Planify to create one for you |
| `/mcp` asks you to authenticate again | Your sign-in expired | Sign in again |
| "It was made from an old revision" | The plan changed after the agent read it | Nothing: the agent reads again and retries |
| Calls refused until 00:00 UTC | You used your 1,000 calls for the day, or the server its 2,000 | Wait, or stop any agent that is looping |
| Any other error that names the server's setup | Something on the server's side, not your access | Tell whoever runs your Planify |

## License

Apache 2.0.
