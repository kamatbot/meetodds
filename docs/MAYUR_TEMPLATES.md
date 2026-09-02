# Mayur meeting templates

The Mayur templates turn a transcript into an operating review, not a generic recap. They are derived from the product-manager principles and coaching model in `kamatbot/future` on `feature/product-manager-coaching`.

## Included templates

| Template ID | Best used for | Primary output |
| --- | --- | --- |
| `mayur_product_review` | Business, product, KPI, roadmap, and delivery reviews | Evidence-led product diagnosis, decisions, experiments, execution contracts, and a full principles scorecard |
| `mayur_decision_review` | Contentious, ambiguous, or high-stakes product decisions | Mission-linked decision rule, options and opportunity cost, reversibility, risk controls, dissent, and accountable follow-through |
| `mayur_pm_one_on_one` | PM 1:1s, coaching, and leadership development | Outcome evidence, growth edge, important-versus-urgent audit, delegation, two-way feedback, and support commitments |

The display names start with `Mayur ·` so they remain easy to find in the existing template menu. Each template is both packaged as an application resource and embedded in the Rust binary as a fallback.

## Principles translated into transcript evidence

1. **Mission over theatre** — use the mission as a concrete decision rule, not a slogan.
2. **Decision velocity with a risk exception** — move reversible decisions quickly; require independent controls where user or company harm can be material.
3. **Intuition to data** — state hypotheses, competing explanations, falsifiers, guardrails, and the decision an experiment will unlock.
4. **Execution over prediction** — identify the thinnest end-to-end outcome that can ship and learn.
5. **Important over urgent** — protect strategic capacity and diagnose repeated fires as system problems.
6. **Be uncomfortably excited** — define a supported, observable growth edge.
7. **Talent density requires time** — make hiring and capability evidence explicit when relevant.
8. **Context, not control** — provide mission, constraints, guardrails, decision rights, and escalation conditions while preserving ownership.
9. **Listen, write, then speak plainly** — represent the strongest opposing view and make the decision, rationale, trade-offs, owner, and next action easy to find.
10. **Feedback as an operating loop** — capture observed behavior, impact, useful next action, and follow-up evidence.
11. **Assume good intent; diagnose the system** — separate facts, inferred intent, incentives, missing context, impact, and repeated patterns.

## Evidence rules

The prompts deliberately instruct the model to:

- say when a mission, owner, deadline, baseline, target, source, or risk control was not established;
- distinguish facts, assumptions, interpretations, and unknowns;
- mark a principle `Not observed` rather than invent supportive evidence;
- distinguish discussion from an actual decision;
- avoid attributing motive from a single interaction;
- keep actions limited to concrete commitments with owners and checkpoints.

## Customization

A user can override any Mayur template by placing a JSON file with the same ID in the application template directory. Meetily loads custom templates before bundled or embedded templates.
