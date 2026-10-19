---
description: Run the quality gate on a completed task — tests, standards, security where required
---

Gate task `$ARGUMENTS` before it can be marked done.

1. Read the task's acceptance criteria from `orchestration/backlog.md`.
2. Dispatch `test-engineer` with those criteria and the task's `owns` files. Its job is to confirm
   every criterion is covered by an **executing** test, and to write the missing ones. A criterion
   asserted in prose is not covered.
3. Dispatch `code-standards-reviewer` on the same files plus the boundary rules in `CLAUDE.md`.
   Check specifically for: domain logic leaking outside its module, missing validation at a
   boundary, duplicated business math, authority rules bypassed.
4. If the task touches auth, permissions, anything mutating authoritative state, or anything
   handling untrusted input, also dispatch `security-reviewer`.
5. Route findings back to the **original implementer** via `SendMessage` so it fixes its own work
   with context intact. Do not patch them yourself — that makes the orchestrator the bottleneck
   this process exists to remove.
6. Re-run the gate once fixes land. Two failed rounds on one task → stop, report it as likely
   mis-scoped, propose a re-decomposition.
7. On pass: set `done` in `state.json` with a one-line note on what was verified.

Report findings by severity with `file:line`. If nothing was found, say so plainly — do not
manufacture findings to look thorough.
