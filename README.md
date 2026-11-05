# Context Cortex

**A self-expanding capability layer for AI.** Any model discovers, experimentally acquires, combines,
retains and transfers new abilities from the software around it, so its practical capabilities grow
through experience rather than only through model upgrades.

Built on [RightClick X](https://github.com/rossbuckley1990-hash/rightclick-x) and its 13 `context_*`
tools. Not another agent framework, MCP server or collection of integrations.

> **Status: research phase. Nothing here is implemented yet.** This repository holds the proposal, a
> draft architecture, draft data schemas and the protocol for the first experiment. Every claim about
> what works will come from a recorded, independently checked experiment, the way RightClick X's do.

## The question

> Can an external capability engine make a fixed AI model measurably more capable over time, across
> unfamiliar tasks and different software environments, more efficiently than a coding agent that saves
> its own scripts?

The decisive evidence is not that the first agent succeeds. It is that **a different, fresh model
inherits the acquired ability and succeeds without new investigation, with less total work than the
saved-script alternative, at the same level of assurance.**

## Where it starts from

RightClick X has already tried a narrow version of this. Its newest independent evaluation (PR #61,
5 November 2026) found:

| | RightClick X | Agent with saved scripts |
|---|---|---|
| Unfamiliar programs acquired | 1 / 6 | 6 / 6 |
| Tasks a fresh agent completed | 3 / 7 | 7 / 7 |
| Silent wrong answers | 0 | 0 |

What held up was the governance: identity pinning, sandboxing, receipts, provenance, refusals and honest
assurance labels. So Context Cortex starts from a hypothesis to test: **the model proposes, the engine
disposes.** The model designs experiments and writes fixtures and validators where it is strong. The
engine runs them bounded, decides what is established, and crystallises, revalidates and transfers the
result. The details, with commits, are in [STARTING-EVIDENCE.md](docs/STARTING-EVIDENCE.md).

## What is here

| | |
|---|---|
| [docs/PROPOSAL.md](docs/PROPOSAL.md) | The original proposal: five forms of operational intelligence, eight higher-order tools, the empirical affordance graph |
| [docs/STARTING-EVIDENCE.md](docs/STARTING-EVIDENCE.md) | What RightClick X has measured, positive and negative, and what it implies |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, the claim model, model-written witnesses, skills, transfer, authority, open decisions |
| [docs/EXPERIMENT-001.md](docs/EXPERIMENT-001.md) | The first experiment: acquire, crystallise, transfer, revalidate, compound; four arms; proposed thresholds |
| [schemas/](schemas/) | Draft 0 JSON Schemas for affordance claims, skills and transfer bundles |
| [examples/](examples/) | An illustrative transfer bundle (placeholder digests, not evidence) |

```bash
npm install
npm test   # validates the example and checks that the schemas refuse what the design forbids
```

## Ground rules

- **Discovery never grants permission.** Exploration stays inside an explicit grant. Unknown effects are
  treated as destructive and run only in a sandbox. Experiments never touch real data or remote state.
- **The engine decides what is true.** A claim is established by trial evidence and a calibrated
  witness, never by documentation or by a model saying so.
- **Equal assurance.** A cheaper result that is less checked is not a win.
- **Development evidence is not acceptance.** The session that builds a candidate does not evaluate it.

## Related work

Procedural learning alone is not new. Context Cortex's bet is making it general, dependable,
transferable and useful across real software.

- Wang et al., [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/abs/2305.16291) (2023)
- Wang et al., [SkillX: Automatically Constructing Skill Knowledge Bases for Agents](https://arxiv.org/abs/2604.04804) (2026)
- Chalef et al., [Learning by Doing: Autonomously Compiling and Curating Agent Skills from Verified Traces](https://arxiv.org/abs/2611.01386) (2026)

## License

Not yet chosen. RightClick X is Apache-2.0.
