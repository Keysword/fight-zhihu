export type ClaimKind = 'fact' | 'statement' | 'inference' | 'unknown' | 'conflict';
export type CaseStage = 'collecting' | 'understanding' | 'waiting' | 'actionable' | 'resolved';
export type Confidence = 'low' | 'medium' | 'high';
export type EvidenceKind = 'message' | 'email' | 'notice' | 'call' | 'note';

export interface Evidence {
	id: string;
	kind: EvidenceKind;
	content: string;
	sourceLabel: string;
	occurredAt: string | null;
}

export interface Claim {
	id: string;
	kind: ClaimKind;
	text: string;
	evidenceIds: string[];
	rationale?: string;
	relatedClaimIds?: string[];
}

export interface Participant {
	id: string;
	name: string;
	role: string;
	providedInfo: string[];
	capabilities: string[];
	decisionScopes: string[];
	coordinationScopes: string[];
	evidenceIds: string[];
}

export interface KeyCompleter {
	participantId: string;
	scope: string;
	rationale: string;
	confidence: Confidence;
	uncertainty: string;
	evidenceIds: string[];
}

export interface ActionBranch {
	when: string;
	then: string;
}

export interface NextAction {
	contactParticipantId: string;
	question: string;
	why: string;
	message: string;
	branches: ActionBranch[];
}

export interface ExternalClue {
	id: string;
	title: string;
	excerpt: string;
	url: string;
	author: string;
	editedAt: string | null;
	authorityLevel: string | null;
	source: 'zhihu' | 'global';
	relevance: string;
	warning: string;
}

export interface BackgroundBoard {
	caseId: string;
	title: string;
	goal: string;
	stage: CaseStage;
	currentBlocker: string;
	claims: Claim[];
	participants: Participant[];
	keyCompleter: KeyCompleter | null;
	nextAction: NextAction | null;
	externalClues: ExternalClue[];
	updatedAt: string;
}

export interface CaseSummary {
	id: string;
	title: string;
	goal: string;
	confusion: string;
	stage: CaseStage;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface CaseRecord extends CaseSummary {
	board: BackgroundBoard | null;
	pendingBoard?: BackgroundBoard | null;
	evidence: Evidence[];
}

export interface AgentEvent {
	id: string;
	caseId: string;
	type: string;
	payload: Record<string, unknown>;
	createdAt: string;
}
