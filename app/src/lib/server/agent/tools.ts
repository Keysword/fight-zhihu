import { isDeepStrictEqual } from 'node:util';
import type { BackgroundBoard, CaseRecord, Evidence, ExternalClue } from '$lib/domain/types';

const INTENT_LANGUAGE =
	/(?:故意|恶意|刻意).{0,8}(?:隐瞒|不说|拖延|为难|针对)|推卸责任|针对新人|不想告诉|甩锅|刁难|打压/;

export type AgentErrorCode = 'SAFETY_REJECTED' | 'TURN_LIMIT_REACHED' | 'SEARCH_LIMIT_REACHED';

export class AgentSafetyError extends Error {
	readonly code: AgentErrorCode = 'SAFETY_REJECTED';

	constructor(message: string) {
		super(message);
		this.name = 'AgentSafetyError';
	}
}

/**
 * 正式通知，或用户显式标记为「已确认」的证据，都可以支撑一条已确认事实。
 * 真实材料里很少有正式通知，因此不能把事实的唯一来源限定为 notice。
 */
function isConfirmedEvidence(evidence: Evidence): boolean {
	return evidence.kind === 'notice' || evidence.confirmation === 'official';
}

function assertKnownEvidence(ids: string[], knownEvidence: Set<string>, context: string): void {
	for (const id of ids) {
		if (!knownEvidence.has(id)) throw new AgentSafetyError(`${context}引用了不属于本案例的证据`);
	}
}

function trigrams(text: string): Set<string> {
	const compact = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
	const values = new Set<string>();
	for (let index = 0; index <= compact.length - 3; index += 1)
		values.add(compact.slice(index, index + 3));
	return values;
}

function assertFactSupport(claim: BackgroundBoard['claims'][number], caseRecord: CaseRecord): void {
	if (claim.kind !== 'fact') return;
	const cited = caseRecord.evidence.filter((evidence) => claim.evidenceIds.includes(evidence.id));
	const confirmed = cited.filter(isConfirmedEvidence);
	if (confirmed.length === 0) {
		throw new AgentSafetyError(
			`已确认事实“${claim.text}”必须引用正式通知，或引用用户标记为已确认的证据`
		);
	}
	const claimParts = trigrams(claim.text);
	const supported = confirmed.some((evidence) => {
		const evidenceParts = trigrams(evidence.content);
		return [...claimParts].some((part) => evidenceParts.has(part));
	});
	if (!supported)
		throw new AgentSafetyError(`正式通知或已确认证据不能支持已确认事实“${claim.text}”`);
}

function assertNoIntentLanguage(board: BackgroundBoard): void {
	const generatedText = [
		...board.claims.flatMap((claim) => [claim.text, claim.rationale ?? '']),
		...board.participants.flatMap((participant) => [
			participant.name,
			participant.role,
			...participant.providedInfo,
			...participant.capabilities,
			...participant.decisionScopes,
			...participant.coordinationScopes
		]),
		...(board.keyCompleter
			? [board.keyCompleter.scope, board.keyCompleter.rationale, board.keyCompleter.uncertainty]
			: []),
		...(board.nextAction
			? [
					board.nextAction.question,
					board.nextAction.why,
					board.nextAction.message,
					...board.nextAction.branches.flatMap((branch) => [branch.when, branch.then])
				]
			: [])
	].join(' ');
	if (INTENT_LANGUAGE.test(generatedText)) {
		throw new AgentSafetyError('背景板包含未经证据支持的动机归因');
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
		assertFactSupport(claim, caseRecord);
		for (const relatedId of claim.relatedClaimIds ?? []) {
			if (!claimIds.has(relatedId)) throw new AgentSafetyError('冲突引用了不存在的判断条目');
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
	}
	if (board.nextAction && !participantIds.has(board.nextAction.contactParticipantId)) {
		throw new AgentSafetyError('下一步联系人不在参与者列表中');
	}
	assertNoIntentLanguage(board);

	const allowedClues = new Map(
		[...(caseRecord.board?.externalClues ?? []), ...availableClues].map((clue) => [clue.id, clue])
	);
	for (const clue of board.externalClues) {
		const original = allowedClues.get(clue.id);
		if (!original || !isDeepStrictEqual(clue, original)) {
			throw new AgentSafetyError('背景板包含未经工具获取或被改写的外部线索');
		}
	}
}
