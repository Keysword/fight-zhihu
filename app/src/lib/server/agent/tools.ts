import type { BackgroundBoard, CaseRecord, ExternalClue } from '$lib/domain/types';

const INTENT_LANGUAGE = /(?:故意|恶意|刻意)(?:隐瞒|不说|拖延)|推卸责任|不想告诉/;

export class AgentSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AgentSafetyError';
	}
}

function assertKnownEvidence(ids: string[], knownEvidence: Set<string>, context: string): void {
	for (const id of ids) {
		if (!knownEvidence.has(id)) throw new AgentSafetyError(`${context}引用了不属于本案例的证据`);
	}
}

export function validateBoardForCase(
	board: BackgroundBoard,
	caseRecord: CaseRecord,
	availableClues: ExternalClue[]
): void {
	if (board.caseId !== caseRecord.id) throw new AgentSafetyError('背景板案例编号不匹配');
	if (board.title !== caseRecord.title || board.goal !== caseRecord.goal) {
		throw new AgentSafetyError('Agent 不能改写案例标题或用户目标');
	}
	const knownEvidence = new Set(caseRecord.evidence.map((evidence) => evidence.id));
	const participantIds = new Set(board.participants.map((participant) => participant.id));
	const claimIds = new Set(board.claims.map((claim) => claim.id));
	if (participantIds.size !== board.participants.length || claimIds.size !== board.claims.length) {
		throw new AgentSafetyError('参与者或判断条目编号重复');
	}

	for (const claim of board.claims) {
		assertKnownEvidence(claim.evidenceIds, knownEvidence, `判断“${claim.text}”`);
		for (const relatedId of claim.relatedClaimIds ?? []) {
			if (!claimIds.has(relatedId)) throw new AgentSafetyError('冲突引用了不存在的判断条目');
		}
		if (INTENT_LANGUAGE.test(`${claim.text} ${claim.rationale ?? ''}`)) {
			throw new AgentSafetyError('判断中包含未经证据支持的动机归因');
		}
	}
	for (const participant of board.participants) {
		assertKnownEvidence(participant.evidenceIds, knownEvidence, `参与者“${participant.name}”`);
	}
	if (board.keyCompleter) {
		if (!participantIds.has(board.keyCompleter.participantId)) {
			throw new AgentSafetyError('关键补全者不在参与者列表中');
		}
		assertKnownEvidence(board.keyCompleter.evidenceIds, knownEvidence, '关键补全者判断');
		if (INTENT_LANGUAGE.test(`${board.keyCompleter.rationale} ${board.keyCompleter.uncertainty}`)) {
			throw new AgentSafetyError('关键补全者判断包含未经证据支持的动机归因');
		}
	}
	if (board.nextAction && !participantIds.has(board.nextAction.contactParticipantId)) {
		throw new AgentSafetyError('下一步联系人不在参与者列表中');
	}

	const allowedClues = new Set([
		...(caseRecord.board?.externalClues ?? []).map((clue) => clue.id),
		...availableClues.map((clue) => clue.id)
	]);
	for (const clue of board.externalClues) {
		if (!allowedClues.has(clue.id)) throw new AgentSafetyError('背景板包含未经工具获取的外部线索');
	}
}
