# Recruitment Agent Web Workbench — D5 Integration Contract

Status: design reference for Issue #4 D5. This document is not a new product PRD, does not authorize a second Web host, and does not replace the current domain contracts.

## 1. Product rule

Recruitment Agent is an Agent that performs recruiting work, not an ATS with a chat assistant. The Agent owns routine execution within its mandate; PostgreSQL domain records remain the source of truth; the user handles only genuine recruiting decisions. Do not expose parser defects, internal tool traces, or routine unverified labels as HR work.

### User boundary — hard product constraint

- The product is exclusively for the recruiting organization's internal users: HR / recruiters, recruiting leads / HR owners, interviewers, approvers, and (where needed) enterprise administrators.
- A candidate is a recruiting business entity and external process participant, **never a Recruitment Agent system user**. Candidate IDs may identify records, applications, resumes, interview participants, and transcript speakers; they must never be treated as login identities, permission principals, Agent operators, Scorecard authors, or decision-makers.
- Do not build candidate login, candidate accounts, a candidate portal, candidate-facing workspace, candidate self-service flows, or candidate-side Agent chat as part of this product.
- Candidates may receive recruiter-managed invitations or communications and may reply or participate in meetings. Those messages/replies/transcripts are external business events or source materials ingested for the internal recruiting team; they do not make the candidate a product user.
- Every UI surface, Agent conversation, task, notification, and action is for an authorized internal recruiting user. A question *about* a candidate is an internal user's request, not a candidate interaction.

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
5. Keep one Agent conversation entry. Its context must be explicit and stable: job-level requests stay job-scoped; an internal recruiter's questions about a candidate stay scoped to that candidate's Application. Switching context must never silently carry the previous application.

## 3A. Role-specific workspaces (one product, different views)

The product has internal recruiting users only. Role-specific interfaces are projections of the same domain objects and DSH host, not separate products or duplicate business workflows.

### Role views

- **HR / Recruiter:** recruitment work overview, assigned jobs and Applications, intake outcomes, screening decisions, interview coordination, pending follow-ups, and candidate/application history.
- **Interviewer:** a focused "My Interviews" / Interview Workspace showing only interviews assigned to the current internal user (or explicitly authorized scope). It provides the interview briefing, job context, the candidate's submitted resume and authorized materials, this round's focus attributes and questions, meeting details, the interviewer's own notes, and that interviewer's independent Scorecard. It does not expose the full HR pipeline or unrelated candidate records by default.
- **Recruiting Lead / HR Owner:** job and rubric configuration, hiring progress, team workload, review of authorized evaluations, and formal decisions within their authority.
- **Approver:** only the approval context and actions assigned to them, with enough business context to make the approval; no need to navigate the entire recruiting workspace.
- **Enterprise Administrator:** organization-level templates, roles, policies, integrations and configuration. This is not the default daily workspace.

The same internal user may hold multiple roles, and role scope may differ by enterprise, team, job, or Interview assignment. A role name alone must not grant access to every record.

### Interview-round-specific experience

- Do not hard-code "first / second / third interview" as product logic. A company may use one interview, two rounds, three rounds, a panel, a practical exercise, a founder conversation, or another named stage.
- Each configured Interview Stage can define its own purpose, focus competencies, interview instructions, suggested/required questions, duration, assigned interviewer(s), Scorecard schema, required submission count, and progression condition.
- All rounds reuse one Interview Workspace component and the same underlying Interview / Application / Scorecard contracts. The active stage configuration changes the briefing, visible prior context, questions, scorecard fields, and allowed actions.
- Multiple interviewers assigned to one stage submit independent Scorecards. A shared stage does not mean a shared or jointly authored Scorecard.
- Later-round interviewers receive a versioned Next Round Brief containing authorized objective context and already-covered areas. Other interviewers' subjective scores and private notes remain hidden by default until the receiving interviewer has submitted their own Scorecard, unless an explicit enterprise policy says otherwise.
- Agent prepares round-specific questions and briefing from the job rubric, stage configuration, resume and authorized prior Interview Records. It must not invent candidate facts or pre-fill/submit an interviewer's subjective evaluation.

### Demo role switch vs real identity

- The current single-user prototype may expose a clearly labelled **Demo identity / View as** selector to demonstrate HR, Recruiting Lead, Interviewer A, Interviewer B and Approver views without implementing multi-user authentication now.
- Switching demo identity must change the view, assigned work, actor identity, data visibility and permitted actions—not merely change a label or theme. Demo Scorecards must persist distinct actor IDs and remain independent.
- The selector is a prototype simulation only. It must not be described as real authentication, real multi-user collaboration, or a security boundary.
- In the integrated product, the active identity comes from DSH's authenticated internal user/session and server-side role/scope assignments. Users cannot self-grant roles by changing a UI selector. Domain/tool actions enforce authorization server-side.
- Candidate identities are never available in this selector and candidates never become system users.

## 3B. Enterprise-configurable recruiting framework

The product must ship with useful defaults and reusable templates, while allowing each enterprise to adapt the framework to its actual recruiting practice without code changes. Do not hard-code one company's process into the product.

### Configuration model

Use an inheritance-and-override model:

1. **Built-in starter templates:** opinionated baseline workflows, role presets, rubrics and interview kits; editable and reusable, not mandatory.
2. **Enterprise defaults:** the organization's role definitions, access policies, standard hiring stages, default rubrics, scorecard rules and Agent action policies.
3. **Department / team overrides:** optional differences for a function or hiring team.
4. **Job-specific configuration:** the actual hiring rubric, interview plan and hiring team for a particular Job.
5. **Interview-stage configuration:** the purpose, focus attributes, instructions, questions, interviewer assignment, scorecard and stage gate for this stage.

A lower layer inherits the higher layer by default and only stores explicit overrides. Provide a clear "inherited / customized" indication and a way to restore the inherited value. Avoid forcing every company to configure every field before it can use the product.

### What enterprises can configure

- Interview plan: stage names, order, optional/required stages, and supported same-stage interviewer panels.
- Stage kit: purpose, focus competencies, instructions, suggested or required questions, time allocation and preparation material.
- Evaluation: rubric dimensions, descriptions, rating scale, weights where useful, required/optional fields, and required independent Scorecard count.
- Team and assignment: internal roles, who owns each stage, interviewer assignments, recruiting owner and approver.
- Visibility and permissions: which roles can see resume material, objective Interview Records, prior Scorecards, private notes, and decision details.
- Workflow gates: what conditions allow progression, who may make each formal decision, and which tasks Agent can perform autonomously.
- Agent behavior: permitted tool actions, actions requiring human approval, notification policy, and stage-specific preparation/summary behavior.

### Versioning and safety

- Publish configuration changes as new versions. Do not silently rewrite a Job, Interview, Scorecard or in-flight Application's historical rubric or stage definition.
- Each Job and Interview pins the effective configuration version used when it was created/started. A deliberate migration to a new version must be explicit and auditable.
- Enterprise configuration changes affect future work by default. Existing in-flight Applications retain their effective snapshot unless an authorized user explicitly migrates them.
- Starter templates are examples and accelerators, not claims that every enterprise should use the same three-round process.
- The first implementation should provide a small, usable configuration surface for the above contracts; do not build an expansive enterprise administration console or production multi-tenant operations system as a prerequisite for the personal demo.

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
- One clear primary action per current context. After an action, update the business state and continue to the next relevant Application/task without forcing a return to the home screen.
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
- No candidate login/account/portal or candidate-facing product surface exists; candidate records and transcript speakers are never treated as system users or action authors.
- Role-specific internal views exist for HR/Recruiter, Interviewer, Recruiting Lead/Owner and Approver, reusing the same Interview Workspace and domain contracts; the prototype's Demo identity selector changes data scope/actions but is explicitly not real authentication.
- Interviewer A/B have independent actor identities and see only assigned Interviews and authorized materials; round-specific briefings, focus attributes, questions and Scorecard schemas come from configuration rather than hard-coded first/second/third-round branches.
- Enterprises can configure and reuse interview plans, stage kits, rubrics, assignments, visibility policies and Agent action gates through built-in templates plus enterprise/team/job/stage overrides; configuration is versioned and in-flight Applications retain their effective snapshot unless explicitly migrated.
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

No main-branch changes, no direct changes to shared plugin entry, no new issue, no Notion write, no independent production frontend, no fake Feishu connection, no fake calendar/email delivery, no production HR organization or multi-tenant administration. No candidate login, account, portal, candidate-facing workspace, self-service product, or candidate-side Agent interaction.

## 3C. Unified V5.2 shell — do not split role workspaces into separate apps

The role-specific experience is integrated into the existing V5.2 Recruitment Agent shell. Do not create a separate role-management prototype, a second application shell, or role-specific top-level navigation trees.

- Keep exactly two primary navigation spaces in the shared shell. Their labels and contents adapt to the active internal role:
  - HR / Recruiter: `正在招聘` + `招聘记录`.
  - Hiring Lead: `招聘总览` + `招聘记录`.
  - Interviewers: `我的面试` + `我的评价`.
  - Approver: `审批工作` + `审批记录`.
  - Enterprise Administrator: `企业配置` + `配置版本`.
- Candidate / Application is a domain record shown in its Job or Interview context, not a top-level navigation destination and never a system-user workspace.
- `待我处理` is not a second candidate/application module. For HR/Lead it is one global Human Attention entry for actionable decisions; remove duplicate attention/task cards from the work overview. For Interviewers, the assigned Interview work list itself contains upcoming interviews and pending Scorecards; do not also show a duplicate inbox with the same work. For Approvers, assigned approvals are shown in their work view. The same task must have one canonical actionable entry.
- Interviewer role views reuse the same Interview Workspace and show only assigned Interview instances. A/B/C demo identities are sample actors for first/second/final round views; the enterprise configuration determines real stage names and assignees. Multiple assignments across rounds are allowed.
- Enterprise configuration is opened contextually from the same shell (e.g. Hiring Lead / Administrator action), not through a new parallel app. Keep the configuration editor progressive: stage definitions are collapsed by default; templates are editable; add/remove/reorder stages; edit purpose, competencies, questions, interviewer assignment, independent Scorecard count, visibility and Agent rules.
- The mobile Agent entry belongs in the bottom navigation; do not use a floating button that overlays interview or decision content.
- The demo identity selector changes the shared work view and sample actor. It is not a candidate identity, real login, or security boundary.

The local artifact `Recruitment Agent · V5.2 Unified Workspace` is the UX reference for this contract. Its SAMPLE state is not production data and its local configuration is not a substitute for PostgreSQL persistence or server-side authorization.
