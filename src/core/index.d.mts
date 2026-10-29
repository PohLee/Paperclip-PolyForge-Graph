export type Actor = { id: string; kind: 'human' | 'agent' | 'system'; roles: string[]; executionId?: string | null };
export type Evidence = { kind?: string; artifactId?: string; version?: string; subjectRefs?: { artifactId: string; version: string }[]; [key: string]: unknown };
export type Node = { id: string; type: 'task' | 'decision' | 'join' | 'end'; role?: string; mode?: 'all'; decisionType?: string; decisionTraceRequired?: boolean; independentOf?: string[]; candidateNodes?: string[]; candidateKinds?: string[]; requiredInputs?: string[]; requiredInputAny?: string[][]; produces?: string[]; review?: { supervisorRole: string; maxSelfReviews?: number; decisionType?: string }; reworkTarget?: string; reworkOutcome?: string; maxReworks?: number; [key: string]: unknown };
export type Graph = { id: string; version: string; start: string; nodes: Node[]; edges: { from: string; to: string; when?: string | string[] }[]; [key: string]: unknown };
export type Pack = { id: string; version: string; graphs: Graph[]; decisionRules?: { type: string; mode: string; allowedKinds?: Actor['kind'][]; allowedRoles?: string[]; requiredEvidence?: string[]; requiresHuman?: boolean; allowUnresolvedSevere?: boolean }[]; [key: string]: unknown };
export type State = { revision: number; packs: Record<string, Pack>; runs: Record<string, unknown>; decisions: unknown[]; audit: unknown[]; idempotency: Record<string, unknown> };
export type SourceRef = { kind: 'run_input'; key: string } | { kind: 'product_decision' | 'decision'; id: string } | { kind: 'artifact'; id: string; version: string } | { kind: 'external'; url: string };
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
export class GraphEngine {
  constructor(options?: { store?: Store; now?: () => string });
  registerPack(pack: Pack): Promise<{ id: string; version: string }>;
  startRun(args: { packId: string; packVersion: string; graphId: string; input?: unknown; actor: Actor; mode?: string; idempotencyKey?: string }): Promise<any>;
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
