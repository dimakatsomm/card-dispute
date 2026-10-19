---
description: Verify a milestone end-to-end against its stated outcome and write the milestone report
---

Close milestone `$ARGUMENTS` (default: the current one in `orchestration/state.json`).

1. Confirm every task in the milestone is `done`. List any that aren't and stop if so.
2. Dispatch `integration-verifier` with the milestone's **stated outcome** from
   `orchestration/backlog.md` — not its task list. The question is "does the thing the owner asked
   for actually work end to end", verified by:
   - full build, typecheck, and every test suite
   - the assembled feature exercised for real, not unit-tested in isolation
   - the milestone's acceptance walkthrough, executed
3. Run `/verify-claims` over any doc changed during the milestone — corrections made in one place
   go stale in another.
4. Write `orchestration/reports/<milestone>.md`:
   - what shipped, with the evidence it works
   - what is covered by tests and what is not
   - what was deferred, and why
   - known gaps and risks
   - decisions the owner now needs to make
5. Update `state.json`: milestone closed, next milestone seeded, open questions carried forward.

**"All tasks passed individually" is not a milestone completion.** A milestone whose suite passes
but whose assembled flow is broken is a *failed* milestone — report it as failed, with the actual
command output.
