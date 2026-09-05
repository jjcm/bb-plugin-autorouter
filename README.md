# BB Auto Router

Auto Router is a standalone bb extension that creates new threads after
choosing a concrete provider, model, and reasoning level from:

1. a model-rated 0–100 task difficulty;
2. live Codex, Claude Code, and Cursor quota remaining;
3. a bundled CursorBench 3.2 score and cost-per-task snapshot; and
4. a user-controlled `$` to `$$$` frugality preference.

No third-party benchmark API is called at runtime. Grok 4.5's published scores
are reduced by 10% as part of the local policy.

## What happens to your prompt

**Every submission first runs a short hidden classification turn on one of your
installed providers, which may not be the provider the thread ends up on.**
Before routing, Auto Router spawns a hidden thread titled "Autorouter
classification" and sends it your prompt text (truncated to 20,000 characters)
plus any custom rating instructions you configured. Its only job is to return a
0-100 difficulty score.

- Provider choice: with the default `automatic` decision agent this is Cursor
  `gpt-5.6-sol-medium`, else Codex `gpt-5.6-luna`, else the first usable model
  with quota remaining. Pick a fixed classifier under **Extensions → Plugins →
  Auto Router** if you want your prompts to go to one known vendor.
- The classification thread is archived and stopped as soon as the score is
  read.

### Residual risk

The classifier is a full coding agent, not a sandboxed text endpoint. It is
instructed not to solve, explain, or act on the task, but prompt text is
untrusted input and a crafted task could try to make it take actions. Auto
Router bounds this two ways:

- It always runs the classifier in a `project-default` environment, never the
  environment or worktree the routed thread is headed for, so it cannot touch
  the checkout you are working in.
- It requests the least-privileged permission preset the provider advertises.
  bb 0.39 has no read-only preset available to plugins, so that floor is
  `accept-edits` — a determined injection could still edit files inside the
  throwaway classification workspace.

## Install

```sh
npm install
bb plugin install . --yes
```

Open **Auto Router** in bb's sidebar, compose with bb's native new-thread
composer, and submit. The extension preserves project, environment,
permission, prompt, mentions, and attachments. It classifies the task, shows
the score and selected agent, creates the real thread with an explicit
provider/model/reasoning tuple, and opens it.

Settings live under **Extensions → Plugins → Auto Router** and autosave. The
same policy is available to agents and scripts:

```sh
bb autorouter status
bb autorouter config --frugality 25
bb autorouter config --instructions "Route CSS-only work to Composer 2.5."
bb autorouter route --prompt "Fix the header spacing"
```

## Routing policy

The classifier is instructed to return only compact JSON containing a 0–100
difficulty score. `automatic` prefers a model with the lightest available
reasoning. Cursor currently advertises `none` on individual model rows while
its ACP launch contract accepts `low` as the minimum, so the extension
reconciles to `low`. If classification fails, routing uses 50/100 and records a
plugin warning.

At the frugality endpoints, the capability curves are anchored to:

| Difficulty | `$`                | `$$$`            |
| ---------: | ------------------ | ---------------- |
|          1 | GPT-5.6 Luna low   | Grok 4.5 medium  |
|         50 | GPT-5.6 Luna high  | GPT-5.6 Sol high |
|         75 | Grok 4.5 medium    | Fable 5 high     |
|        100 | GPT-5.6 Sol medium | Fable 5 max      |

Intermediate values interpolate between those anchors. Provider quota adds a
penalty that grows each time remaining quota halves. A 1/100 task cannot reach
the strongest endpoint and a 100/100 task cannot reach the weakest endpoint.

The classifier may return a model override only when the user prompt requests
that model or custom instructions explicitly route the matching task to it.
The extension independently checks that the model exists and its name is
grounded in one of those two sources before honoring the override.

## Supported providers

Autorouter discovers available Codex, Claude Code, Cursor, and Antigravity
(`agy`) models from BB at route time. OmniRoute remains deliberately outside
this list: it is intended for delegated subagent work rather than interactive
Autorouter threads.

The provider, model, and CursorBench snapshot tables are compiled into the
extension (`router.ts`, `benchmarks.ts`) and cover Codex, Claude Code, and
Cursor as of v0.2.0. Models outside that table are still routable as fallbacks
but do not get a capability or cost score, so the table needs a new release
whenever a provider ships new models.

### Per-difficulty model selection

Antigravity has no CursorBench entry, so under normal benchmark-ranked routing
it is only ever chosen when Codex, Claude Code, and Cursor are all
simultaneously unavailable or quota-exhausted — a narrow, mostly-last-resort
condition.

There is no hardcoded difficulty cutoff or provider priority in the code —
`settings.difficultyBands` is a plain, editable list of native two-sided
range bands, `{ minDifficulty, maxDifficulty, fallbackChain }`, checked
low-to-high by effective lower bound. Either bound may be `null` for
"unbounded" on that side (`minDifficulty: null` matches down to 0,
`maxDifficulty: null` matches up to 100; both `null` matches everything).
The first band whose `[minDifficulty, maxDifficulty]` range (inclusive)
covers a task's difficulty score skips benchmark ranking entirely and
routes straight through that band's own ordered fallback chain — first
provider (or exact `provider/model` pin) that's actually available and
quota-eligible wins. If nothing in the matched band is available, or no
band covers the score at all, routing falls through to the normal
benchmark-ranked path below.

Ranges are genuinely two-sided, not just a series of independent
thresholds — e.g. `0–25` for one model, `26–75` for another, `76–100` for a
third, all expressible as three bands with no gaps or overlaps needed. A
single exact score is just `minDifficulty === maxDifficulty`.

The shipped default reproduces what used to be hardcoded — a `0–25` band
(`minDifficulty: null`) with the chain `antigravity → codex → claude-code`
(Cursor is deliberately not in the default chain; it keeps its normal
ranked path at every difficulty) — but it's just the *default value* of a
setting now, not logic baked into `router.ts`. Add, remove, reorder, or
clear bands freely from the settings page or
`bb autorouter config --difficulty-bands '[...]'`.

An explicit model override (user-requested, or from custom instructions)
still takes priority over band matching and applies before it.

### Decision agent

The model that rates each task's difficulty (0-100) before routing is itself
configurable from the same settings page, via a single searchable
provider/model picker (`Decision agent`):

- **Automatic** (default) tries an ordered `automaticFallbackChain` —
  a plain, editable preference list, same shape and same picker as the
  per-difficulty bands above. In this mode, checking a model in the picker
  toggles its membership in the fallback order shown right below it, instead
  of pinning the classifier to it.
- Picking a specific model instead pins the classifier to exactly that
  model, skipping the fallback order entirely.

If nothing in the fallback order is available, the classifier falls back to
any launchable model, then whatever's first — a last-resort safety net, not
a preference, so it isn't a user-facing setting.

## Current bb extension boundary

bb 0.39 plugins cannot intercept the native root New Thread submit or insert
synthetic thought rows into a core thread timeline. Auto Router therefore uses
its own sidebar page containing bb's native `NewThreadComposer`; routing
activity is shown on that page and in a toast. The created thread itself is a
normal bb thread owned by the selected provider.

## Development

```sh
npm test
npm run typecheck
npm run build
bb plugin dev
```
