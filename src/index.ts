// The library surface. rpt is a binary first, but the engine underneath it is
// plain functions over plain data, and a caller embedding it (a CI step, a
// different front end) needs the use cases and the read model without going
// through argument parsing.
export { approveRun, rejectRun, healApproval, readApproval, actorFromEnvironment, type Actor } from "./app/approveRun.js";
export { assessRun, type RunAssessment } from "./app/assessRun.js";
export { doctor, type Check } from "./app/doctor.js";
export { gateCommit, type GateOutcome } from "./app/gateCommit.js";
export { initRepo, type InitReport } from "./app/initRepo.js";
export { loadRun } from "./app/loadRun.js";
export { dashboardModel, runDetailModel, runDiff, type DashboardModel, type RunDetailModel, type RunSummary } from "./app/readModel.js";
export { recordCommit, attestationFor } from "./app/recordCommit.js";
export { verifyRun, readVerdict } from "./app/verifyRun.js";
export type { Approval, ApprovalDecision, RiskContribution } from "./domain/approval.js";
export type { AgentEvent, EventKind, RunId } from "./domain/events.js";
export type { RiskLevel } from "./domain/policy.js";
export type { AgentRun } from "./domain/run.js";
export type { RunState } from "./domain/state.js";
export type { Verdict, VerdictName } from "./domain/verdict.js";
export type { RptConfig } from "./config/schema.js";
export { assessRisk, type RiskAssessment } from "./risk/assess.js";
export { buildFacts, type RunFacts } from "./risk/facts.js";
