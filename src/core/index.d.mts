export type Actor = { id: string; kind: 'human' | 'agent' | 'system'; roles: string[]; executionId?: string | null };
export type Evidence = { kind?: string; artifactId?: string; version?: string; subjectRefs?: { artifactId: string; version: string }[]; [key: string]: unknown };
export type Node = { id: string; type: 'task' | 'decision' | 'join' | 'end'; role?: string; mode?: 'all'; decisionType?: string; decisionTraceRequired?: boolean; outcomeCapabilities?: Record<string, string>; shadowAllowedActions?: string[]; shadow?: { trigger: 'before-dispatch'; reviewer: 'same-agent'; required: true }; independentOf?: string[]; candidateNodes?: string[]; candidateKinds?: string[]; requiredInputs?: string[]; requiredInputAny?: string[][]; produces?: string[]; review?: { supervisorRole: string; maxSelfReviews?: number; decisionType?: string }; reworkTarget?: string; reworkOutcome?: string; maxReworks?: number; [key: string]: unknown };
export type Graph = { id: string; version: string; start: string; nodes: Node[]; edges: { from: string; to: string; when?: string | string[] }[]; compatibility?: Compatibility; requiredRunInputs?: string[]; [key: string]: unknown };
export type Compatibility = { coreRange?: string; contracts?: Record<string, number>; requiredCapabilities?: Record<string, string> | string[]; optionalCapabilities?: Record<string, string> | string[] };
export type Pack = { id: string; version: string; graphs: Graph[]; compatibility?: Compatibility; release?: { digest: string; publishedAt?: string }; handoffContracts?: { contract: string; version: number; sourceGraphId: string; requiredStatus?: string; targetPackId: string; targetGraphId: string; eventArtifactKind: string; requiredCapability?: string }[]; incomingHandoffs?: { contract: string; contractVersion: number; sourcePackId: string; sourceGraphId: string; targetGraphId: string; requiredCapability?: string }[]; decisionRules?: { type: string; mode: string; allowedKinds?: Actor['kind'][]; allowedRoles?: string[]; requiredEvidence?: string[]; requiresHuman?: boolean; allowUnresolvedSevere?: boolean }[]; [key: string]: unknown };
export type State = { revision: number; packs: Record<string, Pack>; runs: Record<string, unknown>; decisions: unknown[]; audit: unknown[]; idempotency: Record<string, unknown>; control?: { companyId: string; organization: unknown; enabledPacks: { packId: string; version: string }[]; [key: string]: unknown } };
export type SourceRef = { kind: 'run_input'; key: string } | { kind: 'product_decision' | 'decision'; id: string } | { kind: 'artifact'; id: string; version: string } | { kind: 'external'; url: string };
export type ShadowCandidateRef = { id: string; version: string; digest?: string };
export type ShadowPolicy = { enabled: boolean; allowSameAgent: boolean; allowAgentTrigger: boolean; allowGraphTrigger: boolean; maxDurationSeconds: number; allowedAdapterTypes: ('process' | 'codex_local' | 'claude_local' | 'opencode_local')[] };
export type ShadowFinding = { severity: 'P0' | 'P1' | 'P2' | 'P3'; summary: string; sourceRef: ShadowCandidateRef; resolved?: boolean };
export type ShadowReviewResult = { status: 'reviewed'; schemaVersion: 1; verdict: 'accept' | 'rework'; candidateRefs: ShadowCandidateRef[]; findings: ShadowFinding[]; outputDigest: string; provenance?: { adapterType: 'process' | 'codex_local' | 'claude_local' | 'opencode_local'; synthetic: boolean } } | { status: 'synthetic-fixture-reviewed'; findings: ShadowFinding[]; outputDigest: string };
export function validateShadowReviewResult(result: ShadowReviewResult, snapshot: { id: string; candidateRefs: ShadowCandidateRef[] }): ShadowReviewResult & { snapshotId: string };
export type SourcedEvidence = { kind: string; summary: string; sourceRef: SourceRef; [key: string]: unknown };
export interface Store { read(): Promise<State | null>; write(state: State, expectedRevision: number): Promise<void> }
export class RevisionConflict extends Error {}
export function recordIntervention(engine: GraphEngine, args: { runId: string; nodeId?: string | null; actor: Actor; kind: 'retry' | 'judge' | 'approve' | 'carry' | 'trigger' | 'stand-in'; reason: string; evidence: Evidence[]; outcomeSignal: string; idempotencyKey?: string }): Promise<any>;
export function proposeInterventionImprovement(engine: GraphEngine, args: { runId: string; actor: Actor; interventionIds: string[]; mechanism: string; expectedOutcome: string; evidence: Evidence[]; idempotencyKey?: string }): Promise<any>;
export function updateInterventionImprovement(engine: GraphEngine, args: { runId: string; actor: Actor; previousDecisionId: string; status: 'graduated' | 'reopened' | 'retired'; reason: string; evidence: Evidence[]; outcomeSignal: string; idempotencyKey?: string }): Promise<any>;
export function interventionReport(engine: GraphEngine, runId: string): Promise<any>;
export function readyWorkTickets(plan: { tickets: { id: string; deliverable: string; owner: string; verification: string; blockers: string[] }[] }, completedIds?: string[]): string[];
export class MemoryStore implements Store { read(): Promise<State | null>; write(state: State, expectedRevision: number): Promise<void> }
export class FileStore implements Store { constructor(path: string); path: string; read(): Promise<State | null>; write(state: State, expectedRevision: number): Promise<void> }
export const CORE_RUNTIME: { readonly version: '0.8.5'; readonly schemaVersion: 1; readonly contracts: Readonly<Record<string, number>>; readonly capabilities: Readonly<Record<string, string>> };
export function satisfies(version: string, range: string): boolean;
export function capabilityAvailable(pack: Pack | null, graph: Graph | null, name: string, options?: { runtime?: typeof CORE_RUNTIME; availableCapabilities?: Record<string, string> }): boolean;
export function compatibilityIssues(pack: Pack, graph?: Graph | null, options?: { runtime?: typeof CORE_RUNTIME; availableCapabilities?: Record<string, string> }): string[];
export function assertCompatible(pack: Pack, graph?: Graph | null, options?: { runtime?: typeof CORE_RUNTIME; availableCapabilities?: Record<string, string> }): void;
export function preflightPackChange(args: { catalog: Pack[]; enabled: { packId: string; version: string }[]; candidate?: { packId: string; version: string }; activeRuns?: any[]; runtime?: typeof CORE_RUNTIME; availableCapabilities?: Record<string, string> }): { ok: boolean; issues: string[]; unavailableGraphs: { packId: string; version: string; graphId: string; issues: string[] }[] };
export class CompanyControlPlane {
  constructor(options: { store?: Store; companyId: string; now?: () => string; availableCapabilities?: Record<string, string>; trustedProviders?: string[] });
  getSetup(): Promise<any>;
  getTemporaryAgentPolicy(): Promise<TemporaryAgentPolicy>;
  recordTemporaryAgentEvent(args: {actor:Actor;reason:string;operation:string;requestKey:string;requestDigest?:string;temporaryAgentId?:string;outcome:"requested"|"accepted"|"request-failed";error?:string}): Promise<any>;
  configureTemporaryAgentPolicy(args: { policy: Partial<TemporaryAgentPolicy>; actor: Actor; reason: string; idempotencyKey: string }): Promise<TemporaryAgentPolicy>;
  getShadowPolicy(): Promise<ShadowPolicy>;
  configureShadowPolicy(args: { policy: ShadowPolicy; actor: Actor; reason: string; idempotencyKey: string }): Promise<ShadowPolicy>;
  configureSetup(args: { organization: { board: { id: string }; ceo: { id: string }; domainHeads: { domain: string; agentId: string }[] }; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  enablePack(args: { packId: string; version: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  createIntake(args: { projectId: string; title: string; description?: string; requestedPackId?: string; assigneeId?: string; source?: { channel: string; senderId?: string; messageId?: string }; attachments?: any[]; contextRefs?: any[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  routeIntake(args: { intakeId: string; outcome: 'accept' | 'reject' | 'forward-ceo' | 'assign' | 'cancel'; assigneeId?: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  escalateDecision(args: { subjectType: 'intake' | 'work-plan' | 'agent-goal' | 'cross-pack' | 'strategy'; subjectId: string; question: string; options: { id: string; label: string }[]; evidence?: any[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  adjudicate(args: { escalationId: string; outcome: string; evidence: any[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  createWorkPlan(args: { projectId: string; items: { id: string; packId: string; graphId: string; priority: number; dependsOn?: string[] }[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  updateWorkItem(args: { planId: string; itemId: string; status?: 'pending' | 'active' | 'completed' | 'blocked'; priority?: number; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  reconcileWorkPlan(args: { planId: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<{ planId: string; version: number; changes: { itemId: string; runId: string; oldStatus: string; status: string }[] }>;
  readReconciledWorkPlans(args: { planId?: string; actor: Actor; reason: string }): Promise<State>;
  getWorkPlanItemContext(args: { planId: string; itemId: string; actor: Actor; reason: string }): Promise<{ plan: any; item: any; run: any | null }>;
  setGoals(args: { scope: 'company' | 'agent'; subjectId: string; goals: { id: string; title: string; parentGoalId?: string; keyResults: { id: string; baseline?: number; target: number; unit: string; source: string; window: string; windowEnd?: string }[] }[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  getGoalContext(args?: { agentId?: string; projectId?: string }): Promise<any>;
  recordKnowledge(args: { projectId: string; kind: 'product' | 'decision'; title: string; body?: string; sourceRefs: any[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  queryKnowledge(args?: { projectId?: string; kind?: string; q?: string }): Promise<any[]>;
  appendFeedback(args: { projectId: string; subjectId?: string; body: string; sourceRefs?: any[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  takeOver(args: { runId: string; nodeId: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  resolveTakeover(args: { runId: string; takeoverId: string; outcome: 'resume' | 'stop'; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  recordEvidenceReceipt(args: { receipt: { id: string; providerId: string; companyId: string; projectId: string; kind: 'release' | 'metric'; issuedAt: string; expiresAt: string; subjectRefs: { id: string; version: string; digest?: string }[]; data: any }; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  recordHandoff(args: { projectId: string; sourceRunId: string; targetPackId: string; targetGraphId: string; contract: string; contractVersion: number; sourceEvent: { id: string; version: string; digest: string }; artifacts: { id: string; version: string; digest: string; kind?: string }[]; evidenceReceiptId?: string; actor: Actor; reason: string; idempotencyKey?: string; [key: string]: unknown }): Promise<any>;
  recordShadowContext(args: { parentRunId: string; parentTaskId: string; candidateRefs: ShadowCandidateRef[]; payloadDigest: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  prepareShadow(args: { parentRunId: string; parentTaskId: string; role: string; sessionId: string; parentExecutionId?: string; contextRef: { sourceRunId: string; sourceNodeId: string; snapshotId: string; payloadDigest: string }; scope: { allowedActions: string[]; maxTasks: 1; maxConcurrent: 1; maxCostUsd?: number; deadlineAt: string }; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  bindShadowExecution(args: { shadowId: string; executionId: string; finishedAt?: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  openShadow(args: { parentRunId: string; parentTaskId: string; role: string; executionId: string; sessionId: string; contextRef: { sourceRunId: string; sourceNodeId: string; snapshotId: string; payloadDigest: string }; scope: { allowedActions: string[]; maxTasks: 1; maxConcurrent: 1; maxCostUsd?: number; deadlineAt: string }; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  requestShadowStop(args: { shadowId: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  closeShadow(args: { shadowId: string; outcome: string; reviewResult?: ShadowReviewResult; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  reviewOutcome(args: { projectId: string; goalId: string; goalRevisionId?: string; sourceRunId?: string; observations?: { keyResultId: string; evidenceReceiptId?: string; window?: string }[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  adjustStrategy(args: { reviewId: string; changes: { subjectId: string; goals: any[] }[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  setNotificationPreferences(args: { subjectId: string; channels: string[]; events: string[]; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  queueOutcomeReviewReminders(args: { actor: Actor; reason: string; idempotencyKey?: string }): Promise<{ queued: number; skipped: number }>;
  queueRunNotifications(args: { actor: Actor; reason: string; idempotencyKey?: string }): Promise<{ queued: number }>;
  listNotifications(args?: { subjectId?: string }): Promise<any[]>;
  markNotification(args: { notificationId: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  acknowledgeDelivery(args: { notificationId: string; providerRef: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  getAudit(): Promise<any[]>; getIntake(): Promise<any[]>; getPlans(): Promise<any[]>; getShadows(): Promise<any[]>; getReviews(): Promise<any[]>; getHandoffs(): Promise<any[]>; getFeedback(): Promise<any[]>; getEscalations(): Promise<any[]>;
}
export class GraphEngine {
  constructor(options?: { store?: Store; now?: () => string; availableCapabilities?: Record<string, string> });
  registerPack(pack: Pack): Promise<{ id: string; version: string }>;
  registerPacks(packs: Pack[]): Promise<{ id: string; version: string }[]>;
  startRun(args: { packId: string; packVersion: string; graphId: string; input?: { parentRunId?: string; handoffId?: string; projectId?: string; paperclipCompanyId?: string; [key: string]: unknown }; actor: Actor; mode?: string; idempotencyKey?: string }): Promise<any>;
  getRun(runId: string): Promise<any | null>;
  getReadyNodes(runId: string): Promise<Node[]>;
  getWorkItems(runId: string): Promise<{ nodeId: string | null; phase: 'work' | 'supervisor' | 'decision'; kind: 'automatic' | 'agent' | 'human' | 'blocked'; operation: string; role?: string | null; outcomes?: string[]; conflictId?: string; reason?: string }[]>;
  getBlockedNodes(runId: string): Promise<(Node & { status: 'blocked'; missingInputs: string[] })[]>;
  listDecisions(filter?: { runId?: string; feature?: string }): Promise<any[]>;
  getAudit(filter?: { runId?: string }): Promise<any[]>;
  recordDecision(args: { type: string; status: string; outcome?: string | null; reason: string; actor: Actor; question?: string | null; options?: any[]; evidence?: Evidence[]; artifacts?: any[]; knownRisks?: any[]; unresolved?: any[]; supersedes?: string | null; runId?: string | null; nodeId?: string | null; projectId?: string | null; taskId?: string | null; issueId?: string | null; affectedRefs?: any[]; idempotencyKey?: string }): Promise<any>;
  transitionImprovement(args: { runId: string; actor: Actor; previousDecisionId: string; status: 'graduated' | 'reopened' | 'retired'; reason: string; evidence: Evidence[]; idempotencyKey?: string }): Promise<any>;
  recordWorkDecision(args: { runId: string; nodeId: string; actor: Actor; category: 'product' | 'engineering' | 'process'; question: string; options: { id: string; label: string }[]; outcome: string; reason: string; evidence: SourcedEvidence[]; ruleRef?: string; productDecisionRefs?: string[]; behaviorImpact?: 'none' | 'changes' | 'unknown'; changeScope?: string; idempotencyKey?: string }): Promise<any>;
  submitNode(args: { runId: string; nodeId: string; actor: Actor; output?: unknown; artifacts?: any[]; evidence?: Evidence[]; decisionIds?: string[]; productDecisionRefs?: string[]; approvedChangeDecisionId?: string; changeScope?: string; idempotencyKey?: string }): Promise<any>;
  recordSelfReview(args: { runId: string; nodeId: string; actor: Actor; findings?: any[]; fixes?: any[]; artifactVersion: string; revisedArtifact?: any; evidence?: Evidence[]; idempotencyKey?: string }): Promise<any>;
  reviewWork(args: { runId: string; nodeId: string; actor: Actor; outcome: 'accept' | 'rework'; reason: string; evidence?: Evidence[]; knownRisks?: any[]; idempotencyKey?: string }): Promise<any>;
  decideNode(args: { runId: string; nodeId: string; actor: Actor; outcome: string; reason: string; evidence?: Evidence[]; artifacts?: any[]; options?: any[]; idempotencyKey?: string }): Promise<any>;
  escalateNode(args: { runId: string; nodeId: string; actor: Actor; reason: string; evidence?: Evidence[]; options?: any[]; idempotencyKey?: string }): Promise<any>;
  resolveHumanGate(args: { runId: string; nodeId: string; actor: Actor; outcome: string; reason: string; evidence?: Evidence[]; artifacts?: any[]; options?: any[]; idempotencyKey?: string }): Promise<any>;
  pauseRun(args: { runId: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  resumeRun(args: { runId: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<any>;
  recordConflictPosition(args: { runId: string; nodeId: string; actor: Actor; side: 'cpo' | 'cto-caio'; stance: 'go' | 'modify' | 'block'; reason: string; dimensions: Partial<Record<'scope' | 'timeline' | 'resources' | 'risk' | 'successCriteria', string>>; nonNegotiables?: string[]; evidence: SourcedEvidence[]; idempotencyKey?: string }): Promise<any>;
  openConflict(args: { runId: string; nodeId?: string; actor: Actor; positions?: { cpo: unknown; cto: unknown }; positionDecisionIds?: { cpo: string; cto: string }; negotiation?: { dimension: 'priority' | 'scope' | 'risk' | 'resource' | 'fundamental'; issue: string; proposal: string; cpoResponse: string; ctoResponse: string; evidence: SourcedEvidence[] }[]; options?: { id: string; label: string; disposition?: 'continue' | 'rework' | 'stop'; targetNodeId?: string }[]; unresolved: any[]; reason: string; idempotencyKey?: string }): Promise<any>;
  resolveConflict(args: { runId: string; conflictId: string; actor: Actor; outcome: string; reason: string; evidence?: Evidence[]; idempotencyKey?: string }): Promise<any>;
  resolveReworkLimit(args: { runId: string; actor: Actor; outcome: 'continue' | 'stop'; reason: string; idempotencyKey?: string }): Promise<any>;
  invalidateEvidence(args: { runId: string; nodeId: string; actor: Actor; reason: string; affectedNodeIds?: string[]; idempotencyKey?: string }): Promise<any>;
  retryNode(args: { runId: string; nodeId: string; actor: Actor; reason: string; idempotencyKey?: string }): Promise<{ run: any; decision: any; nextAttempt: number }>;
  recordProductDecision(args: { feature: string; actor: Actor; status?: string; outcome: string; reason: string; evidence?: Evidence[]; supersedes?: string | null; proposalId?: string | null; changeScope?: string[]; runId?: string | null; idempotencyKey?: string }): Promise<any>;
  getProductMemory(feature: string): Promise<any>;
  assertProductChangeAllowed(args: { feature: string; referencedDecisionIds?: string[]; approvedDecisionId?: string; changesBehavior?: boolean; changeScope?: string }): Promise<any>;
}

export interface TemporaryAgentPolicy { version: 1; enabled: boolean; maxConcurrentChildren: number; maxDepth: 1; maxDurationSeconds: number; allowSharedWorkspaceWrites: boolean; allowedPurposes: Array<'review'|'research'|'analyze'|'implement'>; maxCostUsd?: number }
export interface TemporaryAgentRequest { id: string; kind: 'sub-agent'|'shadow-agent'; purpose: 'review'|'research'|'analyze'|'implement'; parent: { agentId: string; executionId: string; taskId?: string; runId?: string }; context: { mode: 'fresh'|'fork'; parentSessionRef?: string }; brief: { objective: string; scope: string; outputFormat: string; boundaries: string[]; inputRefs: Array<{kind:string;id?:string;artifactId?:string;url?:string}>; acceptanceCriteria: string[]; allowedActions: string[]; deadlineAt: string }; limits?: { maxTasks: 1; maxConcurrent: 1; maxCostUsd?: number }; workspace?: { mode: 'shared'|'isolated'; writeAccess: 'none'|'exclusive'; writerLeaseRef?: string }; depth?: 1 }
export const TEMPORARY_AGENT_DEFAULT_POLICY: Readonly<TemporaryAgentPolicy>;
export function normalizeTemporaryAgentPolicy(policy?: Partial<TemporaryAgentPolicy>): TemporaryAgentPolicy;
export function validateTemporaryAgentRequest(request: TemporaryAgentRequest, options?: { policy?: TemporaryAgentPolicy; parentAuthority?: any; now?: string; activeChildren?: any[] }): TemporaryAgentRequest;
export function validateTemporaryAgentContextReceipt(receipt: any, request: TemporaryAgentRequest): any;
export function validateTemporaryAgentResult(result: any, request: TemporaryAgentRequest): any;
