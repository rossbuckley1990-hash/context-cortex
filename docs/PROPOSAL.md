# Context Cortex: the original proposal

*Written by Ross Buckley, 5 November 2026. Kept as written, apart from formatting and removed tracking
parameters on links. The design and the first experiment derived from it are in
[ARCHITECTURE.md](ARCHITECTURE.md) and [EXPERIMENT-001.md](EXPERIMENT-001.md). What RightClick X has
measured so far is in [STARTING-EVIDENCE.md](STARTING-EVIDENCE.md).*

---

I think the real opportunity is much bigger than giving AI access to more tools.

What if we could make AI acquire entirely new abilities, discover things it didn't know were possible,
learn from its experiences, and become progressively more capable without changing the underlying AI
model?

That is what I would try to invent using RIGHTCLICK X's context tools suite.

Not another agent framework. Not another MCP server. Not another collection of integrations.

A new layer of intelligence.

## The invention: CONTEXT CORTEX

A self-expanding capability system for artificial intelligence.

Today's AI is extraordinary at reasoning about problems. But its practical abilities remain constrained
by the software interfaces available to it and what it understands about using them.

RIGHTCLICK X already starts solving that problem. Its 13 `context_*` tools allow an AI to discover
software capabilities, inspect their inputs and outputs, compose operations and retain successful
workflows.

I checked the repository, and the foundation is substantial.

But the next breakthrough isn't simply improving `context_learn`.

It's giving AI the ability to identify what it cannot currently do, work out how to acquire that missing
ability, prove the ability works, and make it permanently available to itself and other agents.

## 1. Give AI five new forms of operational intelligence

1. **Capability awareness — knowing what is possible.** AI understands the usable capabilities of its
   environment, including combinations of software that no individual application advertises. It
   distinguishes available functionality from hypothetical possibilities.
2. **Capability imagination — discovering what could become possible.** Given a goal, AI identifies
   missing abilities, hypothesises how existing software might provide them, and discovers unexpected
   combinations. It can say, "I cannot do that yet, but I have a way to investigate."
3. **Experimental intelligence — learning how things actually work.** Instead of assuming documentation
   is accurate, AI constructs bounded experiments, compares competing hypotheses, tests valid and invalid
   inputs, and establishes which operations genuinely work.
4. **Procedural intelligence — turning experiences into abilities.** Once a workflow is demonstrated, it
   becomes a reusable executable capability with prerequisites, success conditions, known limitations
   and provenance. Future agents inherit the ability rather than the original conversation.
5. **Compounding intelligence — abilities creating more abilities.** Every acquired capability becomes a
   potential building block for new discoveries. The system can identify newly reachable goals and
   revisit problems that were previously impossible.

The last capability is the one I find most interesting.

AI's operational intelligence could grow through accumulated, tested experience—even while its model
weights stay unchanged.

That is already an active research area. Voyager explored reusable skills and autonomous learning in
Minecraft. More recent work such as [SkillX](https://arxiv.org/abs/2604.04804) and
[Learning by Doing](https://arxiv.org/abs/2611.01386) investigates skill libraries learned from
experience.

So procedural learning alone isn't a novel invention. Our opportunity would have to be making it
general, dependable, transferable and useful across real software.

## 2. Expand the context tools into an intelligence engine

I wouldn't expose another 50 tools to the model. That would undermine RIGHTCLICK's elegant fixed
interface.

Instead, I'd add a small number of higher-order `context_*` capabilities, supported by deeper internal
engines.

| New capability | What it would enable |
|---|---|
| `context_goal` | Translate an intention into required outcomes, constraints and acceptance conditions |
| `context_gap` | Work out which missing abilities prevent the goal and how they might be acquired |
| `context_experiment` | Design and execute authorised, bounded experiments to establish unfamiliar behaviour |
| `context_possibilities` | Discover valuable new abilities reachable through combinations of current capabilities |
| `context_simulate` | Compare proposed workflows using evidence and non-destructive tests before consequential execution |
| `context_crystallize` | Turn a demonstrated workflow into a durable, reusable executable skill |
| `context_evolve` | Revisit previously failed or limited capabilities when new evidence or software becomes available |
| `context_transfer` | Export a skill with its contracts and evidence so another model or environment can independently revalidate and use it |

These are proposed interfaces, not features that currently exist in the repository.

The critical distinction is that the model shouldn't have to reason through hundreds of raw tool calls
to create each skill. RIGHTCLICK's engine should do much of the deterministic investigation, execution
and evidence processing itself.

Anthropic already offers tool search and programmatic tool calling, including executing multiple calls
without feeding every intermediate result back into the model. We should build on these efficiency
lessons, not compete by simply inventing more tool-selection machinery.

## 3. The most revolutionary part: capability discovery without a predefined task

Imagine that an AI can inspect its authorised environment and identify something nobody explicitly
programmed it to do.

> **Illustrative future experience**
>
> 1. **Discovery.** AI encounters unfamiliar installed software, file formats and API contracts.
> 2. **New possibility.** It discovers that three unrelated programs could together analyse and
>    transform a previously unsupported scientific data format.
> 3. **Experiment.** It obtains authorised samples, tests the transformations and establishes which
>    information survives.
> 4. **New ability.** It creates a reusable transformation capability that didn't exist as an
>    individual tool.
> 5. **Skill transfer.** Claude learns it. A fresh Codex or Gemini agent uses it, without being taught
>    the original instructions.

That's a much more interesting proposition than "AI can call thousands of tools."

It suggests AI can discover new functional possibilities within the software already available to it.

And if one acquired ability exposes the inputs needed to investigate another program, the system could
produce an expanding network of usable capabilities.

This is the direction suggested by RIGHTCLICK's recent AVIF bootstrapping experiment, but on a far more
general scale.

## 4. The architectural breakthrough: move beyond a graph of inputs and outputs

RIGHTCLICK currently has semantic types and relationships between capabilities.

I would expand that into an empirical affordance graph.

A conventional tool graph tells you:

`A accepts PNG → A produces WebP`

An affordance graph would additionally establish:

- Under which conditions the operation works.
- Whether it preserves pixels, metadata or other relevant properties.
- Which authority it requires.
- What changes in the environment after execution.
- What evidence supports the claimed behaviour.
- Whether it can be safely composed with another capability.
- What the system learned from failure.
- Whether a substitute route exists.

This would allow an AI to reason about actions in terms of their consequences, not just matching
schemas.

It could search for ways to achieve a desired state, identify missing prerequisites and determine what
experiments would reduce uncertainty.

That is far closer to a practical model of the software environment than an MCP registry.

## 5. Where the real magic could emerge

I see three especially powerful effects.

**First: compounding ability.** A new capability doesn't merely solve one task. It expands the set of
other capabilities that can be discovered. A decoder can help establish an encoder; an encoder supplies
test inputs for an unfamiliar analyser; that analyser may enable a completely different workflow.

**Second: transferable expertise.** An AI agent can acquire a skill once, and a different model can
inherit an executable contract rather than having to interpret a previous chat or independently
rediscover the same commands. Revalidation ensures that a skill isn't blindly assumed to work in a
different environment.

**Third: awareness of unrealised possibilities.** Instead of only answering "What tools do I have?",
the engine could answer "What useful things can I now do that weren't possible yesterday?" This would be
grounded in graph changes and validated routes, not speculative AI suggestions.

That last capability would make RIGHTCLICK feel much more like an expanding form of intelligence than a
conventional integration product.

## 6. What I would build first

I would not begin by implementing all eight new capabilities.

I'd concentrate on one experiment:

> Can RIGHTCLICK automatically discover and master a useful ability that wasn't explicitly represented
> in its original capability graph, and can a different AI model inherit it?

The experiment should start with a fixed, unfamiliar software environment. The engine receives a
high-level objective, identifies a missing ability, decides which experiments to run, establishes a
contract, discovers a composition and stores a reusable skill.

Then a completely fresh model gets an unseen variation of the task.

The decisive evidence isn't that the first agent succeeded. It's that the second agent succeeds without
new investigation, with less total work than the saved-script alternative.

I'd measure acquisition coverage, novel capabilities established, verified task outcomes, fresh-model
transfer success, model tokens, elapsed time and how much the system's capabilities improve after
repeated learning opportunities.

And I'd impose one non-negotiable limit: exploration stays inside explicitly granted authority.
Discovery never grants permission, and uncertain or potentially destructive effects cannot be treated as
harmless experiments.

## My proposed North Star

> Build an intelligence extension for AI that allows any model to discover, experimentally acquire,
> combine, retain and transfer new abilities from the software around it—so its practical capabilities
> grow through experience rather than only through model upgrades.

This is what I'd dedicate the next RIGHTCLICK research phase to.

Not more OpenAPI adapters. Not another dozen CLI file-format generators. Not a prettier capability
dashboard.

The key scientific question is whether an external capability engine can make a fixed AI model
measurably more capable over time, across unfamiliar tasks and different software environments.

If we can demonstrate that reliably and more efficiently than coding agents building saved scripts,
RIGHTCLICK could become a genuinely important piece of AI infrastructure: not a replacement for the AI
model, but a system through which its usable intelligence expands.
