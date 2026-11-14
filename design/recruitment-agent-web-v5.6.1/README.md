# Recruitment Agent Web Workspace — V5.6.1

Status: **offline UX prototype / design reference**. This is not the DSH-integrated production workbench and does not prove a live Recruitment API, PostgreSQL write path, or real external connector.

## Version and provenance

- Product version: **V5.6.1**
- Source design: Library artifact `Recruitment-Agent-V5.6.1-Workspace-Prototype.html`, based on the V5.5 Unified Workbench.
- Repository baseline before this design branch: `feat/unified-document-intake` at `04d297e402a40633dec859b66cc8c034bc8554c0`.
- This branch is intentionally isolated from the active implementation branch. It adds design assets only.

## Product structure

Only two work views are exposed:

1. **Recruiting workspace** — jobs, applications, resume material, evidence-based screening, interview coordination, submitted evaluations, and recruiting decisions.
2. **Interviewer workspace** — interviews assigned to the current local Demo Actor, briefing, authorized materials, and that interviewer's own Scorecard.

**Human Attention** is the single global entry for actionable human work. It aggregates existing business facts; it is not a new business object or a duplicate task table.

The local selector offers Recruiter, Interviewer A, and Interviewer B. A/B are demo identities for illustrating assignment and authorship separation; they are not authentication and do not establish a security boundary.

## V5.6.1 corrections in this revision

- Uses a V5.6.1-specific localStorage namespace so the prototype does not silently reuse V5.3 state.
- Removes fake candidate-confirmation and meeting-ended UI actions. Scheduling state is not treated as proof that an interview occurred.
- Removes fake automatic resume parsing and synthetic Agent completion. Newly received sample material remains explicitly waiting for real parsing or human review.
- Keeps invite editing as a local draft only; it does not simulate message delivery or candidate confirmation.
- Labels seeded transcript content and meeting details as synthetic sample data, not imported or live meeting records.
- Keeps local Scorecard and decision interactions clearly in prototype scope; they do not write to PostgreSQL.
- Retains the two-workspace layout and single Human Attention entry.

## Business semantics to preserve during implementation

- Candidate is a business entity, not a system user.
- Demo Actor alias is distinct from Agent Preset and Recruitment Context.
- Interview assignment is distinct from the actor performing an operation.
- Transcript acquisition and Scorecard submission are independent work branches.
- Under G3-B, S8→S9 requires a canonical READY Transcript; S9→S10 requires a canonical READY Transcript and at least one SUBMITTED Scorecard. Formal recruiting decision readiness must additionally satisfy the configured required Scorecard count and the current decision contract.
- A Scorecard must be submitted by the assigned human interviewer through a Host-side action; an Agent may prepare briefing/evidence but must not submit on the interviewer's behalf.
- DSH Web remains the only host. This prototype must not be converted into a second production Web shell.

## What this file does and does not prove

| Area | Status |
| --- | --- |
| Static HTML / CSS / inline JS syntax | Checked |
| V5.6.1 local prototype state namespace | Implemented |
| Demo views and local interactions | Prototype only |
| DSH Client Module loaded in the actual local Host | Not verified by this artifact |
| Recruitment API / PostgreSQL read and write | Not connected |
| Demo Actor Session → Actor UUID mapping | Not implemented in this HTML |
| Real calendar / email / meeting / transcript integration | Not connected |
| Real browser end-to-end acceptance | Not claimed by this commit |

## Files

- `index.html` — V5.6.1 offline workspace prototype.

## Next engineering step

Continue through Issue #4 Gate 0 / Gate 1 on the user's actual local DSH Web Host. Verify the exact installed version, Client Module slots, native Conversation integration, Session ID access, and the controlled Demo Actor projection before wiring this design to existing domain tools.
