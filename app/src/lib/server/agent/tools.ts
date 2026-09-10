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

function compact(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 否证与转折词：证据里没出现、结论里却出现时，不允许作为已确认事实。 */
const NEGATION_MARKERS = [
	'尚未',
	'没有',
	'未能',
	'无法',
	'不能',
	'不可',
	'无需',
	'不用',
	'不需要',
	'取消',
	'不再',
	'并非',
	'不是'
];

function assertNoUnsupportedNegation(claimText: string, confirmed: Evidence[]): void {
	const claim = compact(claimText);
	const evidenceTexts = confirmed.map((evidence) => compact(evidence.content));
	for (const marker of NEGATION_MARKERS) {
		if (!claim.includes(marker)) continue;
		if (evidenceTexts.some((text) => text.includes(marker))) continue;
		throw new AgentSafetyError(`已确认事实“${claimText}”包含证据未支持的否定或转折（“${marker}”）`);
	}
}

/** 返回一条 fact 无法成立的原因；成立时返回 null。安全校验与自动降级共用这一套判定。 */
function factSupportProblem(
	claim: BackgroundBoard['claims'][number],
	caseRecord: CaseRecord
): string | null {
	if (claim.kind !== 'fact') return null;
	const cited = caseRecord.evidence.filter((evidence) => claim.evidenceIds.includes(evidence.id));
	const confirmed = cited.filter(isConfirmedEvidence);
	if (confirmed.length === 0) {
		return `已确认事实“${claim.text}”必须引用正式通知，或引用用户标记为已确认的证据`;
	}
	// 只靠零散片段重合不够：结论中出现证据没有的否定/转折时必须拒绝。
	try {
		assertNoUnsupportedNegation(claim.text, confirmed);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	// 结论必须作为证据原文中的一段连续文字出现，而不是拼凑出的新句子。
	const claimTokens = compact(claim.text);
	const supported = confirmed.some(
		(evidence) => claimTokens.length >= 2 && compact(evidence.content).includes(claimTokens)
	);
	if (!supported) {
		return `正式通知或已确认证据没有包含完整的“${claim.text}”，不能作为已确认事实`;
	}
	return null;
}

function assertFactSupport(claim: BackgroundBoard['claims'][number], caseRecord: CaseRecord): void {
	const problem = factSupportProblem(claim, caseRecord);
	if (problem) throw new AgentSafetyError(problem);
}

export interface FactDowngrade {
	id: string;
	text: string;
	reason: string;
}

/**
 * 把没有充分证据支撑的 fact 降级为 statement。
 *
 * 模型经常把“信息已经确认”写成 fact，但只有正式通知或用户显式确认过的证据能
 * 支撑 fact。与其让整轮判断失败，不如保留这条信息、按“他人说法”记录，等用户
 * 在板上确认相关证据后再升级为事实。
 */
export function downgradeUnsupportedFacts(
	board: BackgroundBoard,
	caseRecord: CaseRecord
): { board: BackgroundBoard; downgrades: FactDowngrade[] } {
	const downgrades: FactDowngrade[] = [];
	const claims = board.claims.map((claim) => {
		const problem = factSupportProblem(claim, caseRecord);
		if (!problem) return claim;
		downgrades.push({ id: claim.id, text: claim.text, reason: problem });
		return {
			...claim,
			kind: 'statement' as const,
			rationale: '缺少正式确认，暂按他人说法记录；用户确认相关证据后可升级为已确认事实。'
		};
	});
	return { board: { ...board, claims }, downgrades };
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
