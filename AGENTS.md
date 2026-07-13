# ReadTailor Project Instructions

## Communication

- Be concise and lead with the result. Avoid filler, repetition, and unnecessary process narration.

## Sub-Agent Usage

- Use sub-agents proactively when a task contains independent work that can be investigated or completed in parallel.
- Good sub-agent tasks include repository research, reviewing a separate module, checking contracts or documentation, and running focused verification.
- Give each sub-agent a concrete, bounded scope with a clear expected result.
- Avoid assigning overlapping edits to multiple agents. The primary agent remains responsible for integrating changes, resolving conflicts, and verifying the final result.
- Keep small or tightly coupled tasks with the primary agent when delegation would add more coordination than value.

## Commits

- Organize commits by requirement. Each commit should contain one cohesive requirement and exclude unrelated changes.

## UI And Interaction Acceptance

- The project owner performs all UI and interaction acceptance.
- Do not use browser automation, screenshots, visual comparison, or manual interaction walkthroughs as acceptance work unless the project owner explicitly requests it for the current task.
- For frontend changes, implement the requested behavior and run proportionate technical checks such as type checking, unit tests, and production builds.
- When useful, start the application and provide the local URL so the project owner can perform acceptance.
- After completing a feature addition or behavior change, explicitly list the affected flows, entry points, and key states the project owner should manually verify.
- Do not block completion on self-performed visual or interaction acceptance.
