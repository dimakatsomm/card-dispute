---
description: Pick the next unblocked batch of tasks and dispatch implementers in parallel
---

You are the orchestrator. Execute this sequence:

1. Read `orchestration/state.json` and `orchestration/backlog.md`.
2. Select every task where `status == "todo"` and all `depends_on` are `done`.
3. From that set, build the largest batch whose `owns` file lists are **pairwise disjoint**.
   If two candidates share a file, take the one with more downstream dependents and defer the
   other. Never dispatch two agents that can touch the same file.
4. For each task, dispatch the agent in its `agent:` field with a **self-contained brief**:
   - task id, title, and full acceptance criteria
   - its `owns` list, stated as a hard boundary
   - the specific doc sections it needs — not whole docs
   - the verification commands from `CLAUDE.md`
   - the instruction: stop and report if the task requires a file outside `owns`
5. Set those tasks to `in_progress` in `state.json` **before** dispatching.
6. Report which tasks went out, to which agents, and what remains blocked and by what.

Do not implement any task yourself in this command. If the batch is empty because everything is
blocked, say so and name the blocker rather than inventing work.

Fan out on breadth, not depth: five independent modules = five agents; one hard algorithm = one
agent at high effort, not five guessing in parallel.

$ARGUMENTS may name a specific task id or milestone to scope the selection.
