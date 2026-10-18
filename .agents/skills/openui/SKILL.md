---
name: openui
description: Use OpenUI when the task is to create a landing page, homepage, marketing page, hero page, design concept page, or multiple landing-page variants. First ensure repo-root AGENTS.md contains the OpenUI workflow guidance, then create the repo-root design.md file with fully resolved inputs and a filled version of the master generation prompt for each variant, then implement the page or pages from design.md. Do not use this skill for unrelated coding tasks.
---

# Purpose

OpenUI converts a user request for a landing page into:
1. repo-root workflow guidance in `AGENTS.md` when the repository is missing it
2. a required planning artifact at `/design.md`
3. one or more implemented page outputs that follow `/design.md` exactly

# Mandatory workflow

## Phase 0 — Ensure repo guidance

Before resolving variants or writing `/design.md`, ensure the repository has durable guidance for this workflow.

Determine the repository root:
- If inside a git repository, use the output of `git rev-parse --show-toplevel`.
- Otherwise, use the current workspace root.

Then inspect `<repo-root>/AGENTS.md`.

Rules:
- If `<repo-root>/AGENTS.md` does not exist, create it using the "Required AGENTS.md content" below.
- If `<repo-root>/AGENTS.md` exists and already contains equivalent landing-page workflow guidance, leave it unchanged.
- If `<repo-root>/AGENTS.md` exists but does not contain equivalent landing-page workflow guidance, append only the marked landing-page section from the content below.
- Preserve all existing user or repository instructions. Do not replace, reorder, or remove unrelated `AGENTS.md` content.
- Do not ask the user before creating or appending this guidance. This setup is part of the skill workflow.
- Complete this phase before creating `/design.md`.

Required `AGENTS.md` content for a new file:

```markdown
# AGENTS.md

<!-- openui:start -->
## Mandatory OpenUI workflow

When a task asks for any of the following, use the `openui` skill before editing implementation files:
- landing page
- homepage
- marketing page
- hero page
- design concept page
- multiple landing-page variants
- high-concept page generation

## Required process

1. Before generating page code, create or replace `/design.md` at the repository root.
2. `design.md` is mandatory and is the source of truth for implementation.
3. Never leave unresolved placeholders such as `[Topic]` or `[Offer]` inside `design.md`.
4. If the user omitted inputs, resolve them first and write concrete values into `design.md`.
5. If the user explicitly fixed an input, preserve it.
6. If the user asked for multiple variants:
   - create one section per variant in `design.md`
   - resolve inputs independently for each variant
   - do not copy one variant's input set into another
   - a variant is invalid if it differs only by palette, copy polish, spacing, or superficial decoration
   - each variant must represent a materially different concept direction
   - each variant must define a distinct composition contract, not only distinct copy
7. After `design.md` is written, implement the page variants one by one in the same order they appear in `design.md`.
8. For four or more variants, implement and inspect variants in batches of at most three before continuing.
9. Do not invent proof assets, fake metrics, fake testimonials, fake logos, or fake screenshots.
10. Keep support highlights in one lower support cluster only.
11. Do not use cardified hero layouts, floating sub-surfaces, or generic SaaS dashboard patterns unless the topic explicitly requires that artifact.
12. Before final response, compare all variants together and revise any that feel weaker, repetitive, or merely reskinned.

## Multi-Variant Quality Gates

For four or more variants:

- Add a composition contract for every variant in `design.md`: hero archetype, first-viewport structure, primary visual/proof artifact, interaction behavior, and reuse boundary.
- Work in implementation batches of at most three variants.
- Before each batch, reread the relevant `design.md` sections.
- After each batch, visually inspect desktop and mobile screenshots for every route in the batch before continuing.
- Shared CSS, JS, components, or templates are allowed only for infrastructure such as resets, routing, navigation, basic accessibility helpers, and small utilities.
- Do not implement a large multi-variant request as one generic data-driven page renderer unless each variant still has a custom hero composition, custom visual/proof artifact, and custom interaction behavior.
- Do not let later variants become "same layout plus different copy."
- Ensure the first viewport shows the dominant hero and a hint of the next section on common desktop and mobile sizes unless the user explicitly requests a full-screen hero.

Final comparative gate:

- Review all variants side by side or in a fast route sweep.
- Confirm each variant has a distinct first impression, composition, visual/proof artifact, and interaction behavior.
- Revise later variants if they have degraded into thinner versions of earlier variants.

## Implementation policy

- For a single HTML deliverable, prefer `index.html`.
- For multiple HTML variants, prefer:
  - `variants/variant-01/index.html`
  - `variants/variant-02/index.html`
  - `variants/variant-03/index.html`
- For a single React deliverable, prefer one component file in the existing project structure.
- For multiple React variants, create one component per variant with clear naming.

Do not start implementation until `design.md` is complete.
<!-- openui:end -->
```

When appending to an existing `AGENTS.md`, append only the marked section from `<!-- openui:start -->` through `<!-- openui:end -->`, separated from existing content by one blank line.

## Phase 1 — Determine variant count

Infer the number of required variants from the user request.

Rules:
- If the user asks for one page, create one variant.
- If the user asks for multiple variants, create exactly that many variants.
- If the user asks for "a few" or similarly vague plurality, default to 3 variants.

## Phase 2 — Resolve inputs for each variant

For each variant, resolve all of these inputs before implementation:

- Topic
- Offer
- Audience
- Primary user action
- Deliverable
- Style direction
- Tonal key
- Icon policy
- Proof assets
- Motion intensity

Rules:
- Preserve any input explicitly specified by the user.
- Infer any missing input.
- Re-resolve every input independently for each variant.
- Do not reuse the same inferred combination across variants.
- Variants must differ conceptually, not just cosmetically.
- If the overall topic is fixed by the user, create different topic angles or framings within that topic instead of changing the topic entirely.
- Never invent proof assets. If none are provided and none are credibly available from the prompt, write `none`.
- If motion intensity is not specified by the user, use `Ambient`.

## Phase 3 — Create `/design.md`

Before generating any page code, create or replace `/design.md`.

`/design.md` must contain:

- one top-level title
- one section per variant in order
- a resolved input list for each variant
- a composition contract for each variant
- the fully filled master prompt for each variant
- the intended output file path for each variant

Use this structure exactly:

# OpenUI Design Plan

## Variant 1

### Resolved inputs
- Topic: ...
- Offer: ...
- Audience: ...
- Primary user action: ...
- Deliverable: ...
- Style direction: ...
- Tonal key: ...
- Icon policy: ...
- Proof assets: ...
- Motion intensity: ...

### Composition contract
- Hero archetype: centered | asymmetrical | immersive
- First-viewport structure: concrete description of how headline, proof/visual artifact, optional CTA(s), and any next-section hint fit in the first viewport
- Primary visual/proof artifact: concrete topic-native artifact; write `none` only when the concept is typography-led
- Interaction behavior: concrete CTA or hero feedback behavior, or `none`
- Reuse boundary: what may be shared with other variants and what must be custom for this variant

### Filled generation prompt
[paste the full master prompt with all placeholders replaced by concrete values for this variant]

### Output target
- Path: ...

Repeat for each additional variant.

Validation rules:
- No square-bracket placeholders may remain.
- No variant may be a near-duplicate of another.
- Differences must affect concept, audience framing, offer framing, interaction model, visual logic, or composition strategy — not only color.
- A variant is under-specified if its composition contract would still work after swapping in another variant's topic name.
- For five or more variants, include enough first-viewport specificity to prevent later variants from collapsing into the same layout.

## Phase 4 — Implement

After `/design.md` is complete:
- read Variant 1
- implement Variant 1
- then proceed to Variant 2
- then proceed to Variant 3, and so on

Rules:
- Follow `/design.md` exactly
- Do not silently drift from the resolved inputs
- Do not merge variants together
- For four or more variants, work in implementation batches of at most three variants:
  - before each batch, reread the relevant `design.md` sections
  - after each batch, inspect the produced pages visually before implementing the next batch
  - if a variant is weaker than earlier variants, fix it immediately instead of carrying the weakness forward
- Shared CSS, JS, components, or templates are allowed only for infrastructure such as resets, routing, navigation, basic accessibility helpers, and small utilities.
- Do not implement a large multi-variant request as one generic data-driven page renderer unless each variant still has a custom hero composition, custom visual/proof artifact, and custom interaction behavior.
- Do not let later variants become "same layout plus different copy."
- Keep one dominant hero
- Keep one coherent visual world per variant
- When the concept benefits from a next-section hint, ensure the first viewport shows the dominant hero and that hint on common desktop and mobile sizes; a full-screen hero is allowed when it is clearly stronger.
- Keep support highlights in one lower cluster only when used
- Do not introduce fake proof
- Do not introduce generic SaaS UI patterns unless the variant explicitly calls for them

## Phase 5 — Quality gates

Run quality gates after each implementation batch and again before final response.

Functional gate:
- run the cheapest syntax/build check available for the project
- open every route implemented in the batch
- check for console errors, broken navigation, CTA behavior when present, keyboard focus visibility, and horizontal overflow

Visual gate:
- capture desktop and mobile screenshots for every route implemented in the batch
- inspect the screenshots directly
- verify text fits, hero hierarchy is clear, CTA(s) are visible when present, any intentional next-section hint is visible, and the page does not have incoherent overlap
- compare the batch against earlier variants and revise any variant that feels generic, repetitive, under-composed, or obviously weaker

Final comparative gate:
- review all variants side by side or in a fast route sweep
- confirm each variant has a distinct first impression, composition, visual/proof artifact, and interaction behavior
- if later variants have degraded into thinner versions of earlier variants, revise them before final response

# Master prompt to render into design.md

Create one high-concept page for [Topic].

## Inputs
- Topic: [Topic].
- Offer: [What is being offered. If missing, infer one plausible offer and stay consistent.]
- Audience: [Who it is for. If missing, infer one clear primary audience.]
- Primary user action: [What is the single most important thing the visitor should do next? Examples: explore, sign up, book, join, apply, RSVP, compare, configure, browse, watch, listen, read, download, buy, request access, contact, start demo, view schedule, view collection, submit.]
- Deliverable: [Single-file HTML with embedded CSS and JS | React component. If missing, choose the most appropriate format and return only that.]
- Style direction: [Optional. Choose one dominant direction and use it consistently. Examples: Swiss, Editorial, Organic, Airy, Playful, Glitch, Bauhaus, Industrial, Terminal, Synthwave.]
- Tonal key: [Optional. Light / Mid / Dark / Topic-derived. If missing, choose the strongest topic-native tonal key.]
- Icon policy: [Optional. None / Minimal / Expressive / Topic-native / Auto-if-useful.]
- Proof assets: [Optional. Real numbers, testimonials, screenshots, product surfaces, physical artifacts, references, or none.]
- Motion intensity: [Optional. None / Minimal / Ambient / Rich but controlled. Ambient by default.]

## Objective
Design one premium, memorable page with a dominant hero and one coherent visual world derived from the topic itself.
The result should feel specific, intentional, and action-oriented when the concept calls for action, not like a generic startup or SaaS template.

Choose the strongest clear solution.
Do not collapse the concept into a simpler generic pattern just to make execution easier.

- Treat single-file execution as a packaging constraint, not a creative constraint.
Do not reduce conceptual ambition, visual specificity, interaction richness, or production quality merely because the deliverable is concise.

## Internal concept choice
Before composing, decide internally:
- one dominant hero archetype: centered / asymmetrical / immersive
- one dominant proof mode: none / embedded gesture / single artifact
- one palette driver derived from the topic
- one tonal key: light / mid / dark / topic-derived
- one motion role: none / minimal / ambient / interactive
- one icon approach: none / minimal / expressive / topic-native
- optionally one secondary accent only if it strengthens the main direction without creating a second visual world
Do not output this planning.

## Non-negotiables
- Use a strong hero-first composition.
- Headline: 3-12 words, max 3 lines.
- Supporting copy: 1-2 short sentences, concise and specific.
- CTAs are optional. If used, include at most 1 primary and 1 secondary CTA.
- If a clear next step is central to the offer or concept, include a CTA; otherwise CTA omission is allowed.
- CTA labels must be specific to the offer and action, not generic.
- Supporting highlights are optional. If used, show them only once in a single lower support cluster beneath the hero.
- Keep the hero dominant, focused, readable, and uncluttered.
- Proof is optional. Use it only if it clearly strengthens the concept.
- If no real proof assets are provided, do not invent metrics, testimonials, customer logos, screenshots, or fake UI proof.
- Prefer depth inside the hero, proof gesture, CTA behavior, support copy, or background logic rather than adding extra sections by default.

## Composition
- Choose the clearest structure for the topic; do not default to generic two-column marketing layouts.
- A top navigation bar is optional. When used, make it native to the chosen style direction and subordinate to the hero rather than a generic boxed header.
- The hero may be fully integrated rather than framed.
- The hero does not need to become a panel, dashboard, device mockup, rounded card, or floating showcase unless the topic genuinely demands that artifact.
- Build hierarchy through scale, contrast, spacing, alignment, depth, rhythm, and composition before using frames, dividers, or containers.
- Keep supporting content clearly subordinate to the hero.
- Do not interpret structural restraint as permission to flatten the concept into a generic minimal layout.
- Do not use text-on-text layering, typographic collisions, or overlapping live text as a compositional device.

## Visual system
- Build one coherent visual world derived from the topic itself.
- Let the topic drive palette, contrast, typography, spacing, geometry, motifs, materials, and motion.
- Even restrained palettes must feel intentional and specific, not generic premium-neutral.
- The background must actively contribute mood, depth, and topic logic.
- If the topic suggests a real system language, physical behavior, or interface grammar, show that directly instead of generic abstract-tech decoration.
- Treat headline typography as part of the concept, not neutral text.
- The headline may use topic-derived color, selective emphasis, multi-tone treatment, or gradient accents when they strengthen the concept and remain readable.
- Do not default the headline to neutral black, white, or near-white unless that is clearly the strongest topic-native choice.

## Background and tonal diversity
- Premium and atmospheric design may be light, mid-tone, or dark; do not default to dark.
- Choose the tonal key from the topic, offer, audience, and style direction rather than from generic cinematic or tech aesthetics.
- Contrast may come from hue, saturation, temperature, texture, density, or scale, not only darkness.

## Proof and concept expression
- Prefer the minimum visual evidence needed to make the idea feel specific, credible, and native to the topic.
- If the concept is strongest with typography, atmosphere, and one precise gesture, do that.
- If a stronger proof artifact is justified, use one legible, unified artifact rather than multiple fragmented panels.
- Proof may take the form of a signal, trace, contour, command line, path, specimen, structural mark, scene fragment, or other topic-native evidence.
- Typography itself may carry part of the concept or proof.
- When appropriate, use one precise typographic gesture—such as selective word emphasis, chromatic offset, gradient emphasis, distortion, signal breakup, or structural interruption—to make the concept feel more specific and alive.
- Prefer one strong typographic intervention over many scattered decorative effects.
- Avoid decorative pseudo-proof.
- Avoid turning simple ideas into framed showcases, dashboard fragments, floating panels, softened slabs, or generic marketing geometry.

## Icons and symbolic language
- Icons are optional.
- Use icons only when they improve scanability, recognition, navigation, proof clarity, or support-cluster legibility.
- Prefer topic-native icon logic over generic startup glyphs.
- Keep icon style consistent in stroke weight, geometry, corner logic, and detail level.
- Use icons primarily in clearly secondary roles unless a single topic-native symbol is central to the concept.
- Do not let icons compete with the hero headline, proof artifact, or CTA hierarchy.

## Support cluster
- If used, show supporting highlights only once, in a single lower cluster beneath the hero.
- Each highlight should be short, fast to scan, and clearly secondary.
- Supporting highlights may use concise icons or symbolic marks when helpful.
- Support-cluster elements may use subtle motion when it improves scanability, continuity, or atmosphere and remains clearly secondary.
- Card-like grouping is allowed only inside this lower support cluster.
- These modules may use at most one light surface treatment, such as a subtle stroke, tonal fill, or very soft shadow.
- Keep support modules uniform, non-nested, and visually subordinate.
- Do not use card-like structures in the hero, proof, CTA area, or elsewhere on the page.

## Motion
- Motion is optional.
- Use motion only when it supports hierarchy, continuity, feedback, atmosphere, or topic logic.
- Default to none, minimal, or ambient motion depending on what the concept actually needs.
- Motion may live in typography, background behavior, proof logic, support-cluster behavior, or interaction feedback.
- A single key word or short phrase may use subtle text-based motion such as glitch, flicker, jitter, scanline shift, chromatic split, text scramble, pulse, or reveal if it strengthens the concept.
- Keep motion controlled, readable, non-blocking, and subordinate to clarity.
- Avoid scrolljacking, attention-hijacking loops, and ornamental animation.
- Respect reduced-motion preferences.

## Accessibility and readability
- Preserve strong readability and clear hierarchy at all viewport sizes.
- Maintain sufficient contrast between text and background.
- Do not place essential text over busy imagery unless readability remains strong.
- Avoid cramped spacing, visual collisions, and weak focal hierarchy.
- Do not place badges, pills, annotations, stickers, or floating interface fragments over essential text.
- If the deliverable is code, use semantic HTML structure, visible focus states, keyboard-friendly interactions, and reduced-motion handling.
- When in doubt, preserve legibility over expressive overlap.

## Anti-drift rules
- Do not drift into bland corporate SaaS styling.
- Do not default to dashboard aesthetics, feature-grid thinking, boxed-section composition, or template-like modularity.
- Do not use disconnected motifs, random color choices, or interchangeable abstract-tech shapes.
- Do not use card-within-card composition, nested surfaces, floating panels, fake proof, or stock-looking UI.
- Keep one visual world, one dominant hero, and one clear structural logic.
- Do not allow text, labels, or interface elements to overlap, collide, or sit on top of one another.

## Output
Return only the final [Deliverable].

If the deliverable is code:
- Output a complete production-ready file or component.
- Keep dependencies minimal unless explicitly requested.
- Make it responsive.
- Keep support highlights in one lower support cluster only when used.

## Final self-check
Before returning, verify that the result keeps:
- one dominant hero
- one coherent visual world
- no invented proof
- no cardification outside the lower support cluster
- no generic SaaS drift
- no unnecessary structural fragmentation
- no nested containment
- no floating sub-surfaces
- all text clearly legible and comfortably spaced
