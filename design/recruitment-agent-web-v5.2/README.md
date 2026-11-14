# Recruitment Agent Web Workbench — D5 Integration Contract

Status: design reference for Issue #4 D5. This document is not a new product PRD, does not authorize a second Web host, and does not replace the current domain contracts.

## 1. Product rule

Recruitment Agent is an Agent that performs recruiting work, not an ATS with a chat assistant. The Agent owns routine execution within its mandate; PostgreSQL domain records remain the source of truth; the user handles only genuine recruiting decisions. Do not expose parser defects, internal tool traces, or routine unverified labels as HR work.

## 2. Host and extension boundary

- DSH Web remains the only host. Do not create a parallel standalone production app, router, Agent runtime, API server, or second conversation system.
- Recruitment UI is a DSH Web client extension. Notion architecture page 13 describes the prototype pattern as a Web client declaration with client slots, including a main panel and sidebar.panellist entry. Treat this as a candidate extension seam, not as proof that the current installed DSH version is compatible.
- Before implementation, W0 must complete the minimum Web Plugin Proof: record exact DSH/package versions, register one isolated client extension, render it in the actual DSH Web host, and prove it can invoke an existing recruitment tool. No shared plugin entry or host changes until the proof and file ownership are agreed.
- The current main branch does not yet contain a browser client: dsh/dsh-recruitment/package.json has no client declaration and src/index.ts explicitly states that there is no browser half. Do not claim that V5.2 is already integrated.

## 3. Information architecture

Keep the product surface small and contextual:

1. One primary recruitment work view: current job/application context, current business stage, completed outcomes, next human action (if any), and Agent input scoped to the current context.
2. One global Human Attention entry: a single count in the host navigation and one actionable list. Do not repeat the same count or the phrase 'Agent has prepared results and is waiting for your decision' in banners, cards, summaries, and drawers.
3. Recruitment records are retrieved when needed. Job, Candidate, Application, ResumeVersion, Interview, Transcript, Scorecard, and Decision are not seven mandatory top-level destinations.
4. Detailed source material and event history are progressive disclosure. Default view shows recruiting conclusions and useful next actions, not internal execution logs.
5. Keep one Agent conversation entry. Its context must be explicit and stable: job-level requests stay job-scoped; candidate questions stay application-scoped. Switching context must never silently carry the previous application.

## 4. Resume and screening behavior

- The submitted resume is the factual basis for ordinary initial screening. Agent/parser must extract, order, and interpret normal resume content without asking HR to verify routine fields.
- Do not surface 'unverified' or 'please confirm experience order' for ordinary resume content. If the resume does not mention a requirement, say 'not provided in the resume'; do not infer or invent it.
- Raw resume evidence is available on demand to explain a conclusion. It is not a default HR verification task.
- Parsing, ordering, OCR, structure validation, retry, and fallback are system responsibilities. Only genuinely unprocessable material may become an actionable intake issue (retain original, explain the failure in business language, and offer retry/re-upload). Never create a Candidate/Application from an unprocessed file name.
- The UI must distinguish Intake, Candidate, and Application. Intake is a received material event; a formal Candidate/Application is created only after the accepted identity/intake flow.
- Agent's recommendation is not the formal screening decision. HR's explicit action is the decision; do not add mandatory reason text or duplicate confirmation when the action itself is clear.

## 5. Business state and parallel work

- Do not collapse Agent task state, Application stage, Interview scheduling state, Transcript state, Scorecard state, and Decision state into one progress label.
- Events and history must bind to stable Application IDs, not candidate display names.
- Interview transcript acquisition/import and interviewer Scorecards are independent branches after the interview. A missing transcript must not block an interviewer from submitting an independent Scorecard.
- Demo actors A and B may be operated by one developer, but their Scorecards must have separate actor identity and independent records. The Agent must never submit or impersonate a Scorecard.
- A human decision is explicit and has no preselected outcome. Persist actor, time, Application, and the relevant rubric/decision basis automatically; do not force repetitive explanation.
- Scheduling statuses must describe only facts actually achieved. For Issue #4's local demo, the minimum is one Interview with an agreed time and a meeting reference entered by the user. Do not claim a calendar invitation was sent or a candidate confirmed unless an actual integration proves it.
- Manual transcript import is a legitimate local demo path and must be marked MANUAL/IMPORTED. It is not Feishu LIVE. Feishu API/CLI integration and its live gate remain separate.
- Offer authoring, external email delivery, automated calendar coordination, multi-platform subscriptions, and production tenant administration are outside Issue #4's current local Golden Path unless an existing approved contract already requires them. Do not expand the demo into a full enterprise ATS.

## 6. UI behavior rules

- Show each fact once, at the point where it supports a decision or action.
- The same pending item appears in one global attention list; other views may show the business state but must not repeat the same alert copy.
- Routine Agent execution is quiet. Show outcomes and blockers; expose detailed traces only on demand.
- One clear primary action per current context. After an action, update the business state and continue to the next relevant candidate/task without forcing a return to the home screen.
- No destructive change before a user confirms a replacement: editing/rescheduling is a draft until saved; canceling an editor preserves the previous confirmed state.
- Role restrictions must be enforced by the domain/tool action, not only by hiding UI buttons.
- All actions must support keyboard access and visible focus; dialogs manage focus and restore it on close; mobile controls must not obscure primary content.

## 7. D5 implementation order and ownership

1. W0 first reconciles the latest #1/#3 state, D1-D4 owners/worktrees, existing DB objects and tool contracts. Do not create a new issue; Issue #4 is the single coordinator.
2. W0 performs the minimum DSH Web Plugin Proof described in section 2. The proof is a prerequisite for choosing the exact client API, not a reason to build another host.
3. D1-D4 implement thin, real domain capabilities against existing Job/Rubric, Interview/Meeting, Transcript/Interview Record, Scorecard, and Decision contracts/tables. Reuse existing schemas and tools; do not add new services or broad modules for the sake of UI.
4. D5 then renders one real recruitment work view inside DSH Web, reading the domain state and invoking the existing Agent/tools/actions. The V5.2 standalone HTML is a UX reference only; do not copy its local sample-state implementation into production.
5. Keep #1/#3 ownership and shared-file gates intact. W0 alone owns shared plugin registration, DSH profile/client entry, and integration changes.

## 8. Acceptance

- Actual DSH Web host renders the Recruitment client extension; exact DSH version and extension registration evidence are recorded.
- The view reads real Job/Rubric and Application state from the existing domain; no SAMPLE values are presented as live.
- One Application can traverse the Issue #4 local Golden Path: Job/Rubric → resume intake/accepted structure → screening recommendation → explicit human screening decision → one Interview → manual transcript import → two independent demo-actor Scorecards → Agent summary → explicit human Decision.
- Every write is read back from PostgreSQL. Refresh/session recovery preserves the same business state.
- The transcript branch and Scorecard branch can proceed independently.
- Human Attention has one canonical entry point; the same task is not duplicated in multiple cards/banners.
- Real Agent tool trace demonstrates autonomous routine work; human actions are performed by the user/approved actor, never fabricated by the Agent.
- Feishu LIVE is reported separately. Manual import does not satisfy the LIVE gate.
- Tests report passed, failed, and skipped. A passing static prototype test is not DSH Web or database integration evidence.

## 9. Current repository facts at handoff

- Repository: Bruce-Yii/recruitment-agent.
- Main baseline observed: f961026e2d2550a2a283bf09e0d28e631387b2d7.
- Issue #1 remains open/NO-GO; PR #2 remains Draft at f7389d533c47556c69eceefcc0e2b128ef62db60.
- Issue #3 remains open and owns the deep resume reader/quality work.
- Issue #4 remains open and is the correct D1-D5 coordinator; its current correction comment is present, but no W0 owner/worktree kickoff has been posted yet.
- Main's dsh/dsh-recruitment package has no browser client declaration; src/index.ts explicitly describes a host-only plugin. docs/18 also records S8-S10 tools as not yet implemented at the baseline.
- Notion architecture page 13 says the DSH Web host direction is confirmed but local compatibility and minimum plugin proof remain pending.

## 10. Explicit non-goals

No main-branch changes, no direct changes to shared plugin entry, no new issue, no Notion write, no independent production frontend, no fake Feishu connection, no fake calendar/email delivery, no production HR organization or multi-tenant administration.