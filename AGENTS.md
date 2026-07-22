# ReadTailor Project Instructions

## Language
请说中文

## Communication

- Be concise and lead with the result. Avoid filler, repetition, and unnecessary process narration.
- Communicate with the project owner at the technical-lead and system-decision level. Translate implementation details into the affected business capability, data flow, and module boundary, then explain the trigger, the system's handling, and the observable impact. Treat file names, functions, and variables as supporting evidence or engineering locators rather than the main narrative.
- Build a shared system model before descending into code details. Make clear whether a change affects externally observable behavior, data or contracts, failure handling, or only the internal implementation, so the project owner can make a technical decision without reconstructing the business meaning from code identifiers.
- Ask the project owner promptly whenever requirements, constraints, or expected behavior are unclear and could materially affect the implementation; do not proceed based on unsupported assumptions.
- When editing a document, interpret the project owner's statement that an existing point does not need changing as a request to leave that part alone, rather than adding an unnecessary sentence that calls out its unchanged status. Apply this with reasonable contextual judgment instead of treating it as a rigid rule.
- When reviewing code or documents, raise only substantive, actionable issues with a meaningful impact; do not manufacture findings from personal preferences, harmless wording differences, or inconsequential details.

## Sub-Agent Usage

- Default to handling the task with the primary agent. Use sub-agents only when there are clearly independent workstreams and parallel execution provides a meaningful benefit.
- Do not use sub-agents for small tasks, tightly coupled changes, routine repository exploration, or work the primary agent must understand before making a decision.
- Use the smallest number of sub-agents needed. Do not create sub-agents merely to increase parallelism, and do not ask a sub-agent to create more sub-agents unless the task explicitly requires it.
- Before delegating, inspect enough of the repository and current task to provide complete context. Each assignment must include the user's goal, relevant decisions and constraints, important file paths or code context, the exact scope, whether edits are allowed, and the expected result and verification.
- Do not rely on automatically inherited conversation context. Restate all information the sub-agent needs to complete its assignment correctly, including relevant instructions from this file and any user clarifications.
- Give each sub-agent a concrete, bounded, non-overlapping scope. Prefer read-only investigation or focused verification unless ownership of a specific edit is explicitly assigned.
- The primary agent remains responsible for integrating results, resolving conflicts, checking that recommendations fit the broader codebase, and performing final verification.

## Commits

- Organize commits by requirement. Each commit should contain one cohesive requirement and exclude unrelated changes.

## Engineering Quality

- Do not satisfy a requirement through architecturally unsound shortcuts, fragile workarounds, duplicated or accumulating technical debt, or by merely shifting the problem elsewhere; implement a solution that fits the existing design and addresses the root cause.
- Do not introduce unnecessary code or engineering complexity through excessive defensive programming; keep safeguards proportionate to realistic risks, established contracts, and the system's actual requirements.
- Source files must include at least a file-level comment explaining the file's responsibility; large files must also include module-level comments that explain their major modules or logical sections.

## UI And Interaction Acceptance

- The project owner performs all UI and interaction acceptance.
- Do not use browser automation, screenshots, visual comparison, or manual interaction walkthroughs as acceptance work unless the project owner explicitly requests it for the current task.
- For frontend changes, implement the requested behavior and run proportionate technical checks such as type checking, unit tests, and production builds.
- When useful, start the application and provide the local URL so the project owner can perform acceptance.
- After completing a feature addition or behavior change, explicitly list the affected flows, entry points, and key states the project owner should manually verify.
- Do not block completion on self-performed visual or interaction acceptance.
