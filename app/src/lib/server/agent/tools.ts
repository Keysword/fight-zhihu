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

/** 句子边界：条件可能落在前一分句，因此条件词按整句判定。 */
const SENTENCE_SEPARATORS = /[。；！？\n\r]+/;
/** 分句边界：把否定、疑问、未确认限定在它们实际作用的那一段里。 */
const CLAUSE_SEPARATORS = /[。；！？，,、：:\n\r]+/;

/**
 * 否定与排除词：只在该分句范围内判定。
 * 若按整句判定，“不能领取钥匙，但可以进入园区”会误伤后半句这个独立断言。
 */
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
	'不是',
	'不得',
	'禁止',
	'拒绝'
];

/** 条件词：条件可以出现在前一分句，所以按整句判定。 */
const CONDITION_MARKERS = ['如果', '若', '假如', '倘若', '一旦', '除非', '要是', '假设'];

/** 疑问与未确认转述：这类语境里的片段不构成独立断言。 */
const UNCERTAIN_MARKERS = [
	'是否',
	'吗',
	'据说',
	'听说',
	'待确认',
	'尚未确认',
	'无法确认',
	'未核实',
	'不确定',
	'存疑',
	'有待',
	'求证'
];

export type FactSupportIssueKind =
	'invalid_evidence_reference' | 'content_unsupported' | 'source_unconfirmed';

export interface FactSupportIssue {
	kind: FactSupportIssueKind;
	/** 面向用户的说明，按真实原因生成，不套用统一话术。 */
	message: string;
}

/** 归属动词：模型常写成“某某表示：<原文>”，这只是出处说明，不改变被引内容。 */
const ATTRIBUTION_VERBS = [
	'表示',
	'说',
	'告知',
	'回复',
	'反馈',
	'称',
	'指出',
	'提到',
	'说明',
	'通知'
];

interface TextUnit {
	text: string;
	start: number;
	end: number;
}

/**
 * 按分隔符把原文切成单元，并记录每个单元在“去标点串”中的区间。
 * 这样既能把否定限定在分句内，又能判断结论横跨了哪些分句。
 */
function layeredUnits(text: string, separators: RegExp): TextUnit[] {
	const parts = text
		.split(separators)
		.map((part) => compact(part))
		.filter((part) => part.length > 0);
	let offset = 0;
	return parts.map((part) => {
		const unit = { text: part, start: offset, end: offset + part.length };
		offset += part.length;
		return unit;
	});
}

/**
 * 结论的候选匹配串。
 *
 * 逐字引用原文是最常见也最安全的写法；其次是加上“某某表示：”这类出处前缀。
 * 后者只剥离归属说明，被引内容仍须逐字出现在原文里并通过作用域检查。
 */
function candidateSpans(claimText: string): string[] {
	const claim = compact(claimText);
	const candidates = [claim];
	for (const verb of ATTRIBUTION_VERBS) {
		const marker = compact(verb);
		const at = claim.indexOf(marker);
		if (at <= 0) continue;
		const rest = claim.slice(at + marker.length);
		if (rest.length >= 2) candidates.push(rest);
	}
	return candidates;
}

/**
 * 在证据原文里寻找一段能支撑该结论的独立断言。
 *
 * 结论必须作为原文中一段连续文字出现，且不能是从否定、疑问、条件或未确认
 * 转述的范围里截取出来的肯定片段。这是一个保守的确定性规则，不声称解决了
 * 任意自然语言语义：拿不准的复杂语境一律拒绝。
 */
function findScopedSupport(
	claimText: string,
	evidenceList: Evidence[]
): { ok: true } | { problem: string } {
	const candidates = candidateSpans(claimText);
	if (candidates[0].length < 2) return { problem: '结论过短，无法与原文核对' };
	let unsafeScope: string | null = null;
	for (const evidence of evidenceList) {
		const compactEvidence = compact(evidence.content);
		const clauses = layeredUnits(evidence.content, CLAUSE_SEPARATORS);
		const sentences = layeredUnits(evidence.content, SENTENCE_SEPARATORS);
		for (const candidate of candidates) {
			const at = compactEvidence.indexOf(candidate);
			if (at === -1) continue;
			const end = at + candidate.length;
			// 结论可能横跨多个分句（例如逐字引用整条证据），逐个检查被覆盖的分句。
			const clauseMarker = clauses
				.filter((unit) => unit.start < end && unit.end > at)
				.flatMap((unit) =>
					[...NEGATION_MARKERS, ...UNCERTAIN_MARKERS].filter(
						(marker) => unit.text.includes(marker) && !candidate.includes(marker)
					)
				)[0];
			if (clauseMarker) {
				unsafeScope = `不能从否定、疑问或未确认的表述中截取（“${clauseMarker}”）`;
				continue;
			}
			// 条件可能落在前一分句，因此按结论覆盖到的整句判定。
			const conditionMarker = sentences
				.filter((unit) => unit.start < end && unit.end > at)
				.flatMap((unit) =>
					CONDITION_MARKERS.filter(
						(marker) => unit.text.includes(marker) && !candidate.includes(marker)
					)
				)[0];
			if (conditionMarker) {
				unsafeScope = `不能从条件句里截取（“${conditionMarker}”）`;
				continue;
			}
			return { ok: true };
		}
	}
	return { problem: unsafeScope ?? '原文里没有出现这段连续文字' };
}

/**
 * 结构化判定一条 fact 是否成立；成立时返回 null。
 *
 * 顺序很重要：先确认原文确实表达了这个内容（内容支持），再看引用证据是否
 * 得到正式确认（来源）。这样“来源未确认”就不会被用来保留一条原文从未说过的
 * 结论——那正是自动降级最容易被滥用的地方。
 */
export function evaluateFactSupport(
	claim: BackgroundBoard['claims'][number],
	caseRecord: CaseRecord
): FactSupportIssue | null {
	if (claim.kind !== 'fact') return null;
	const cited = caseRecord.evidence.filter((evidence) => claim.evidenceIds.includes(evidence.id));
	if (claim.evidenceIds.length === 0 || cited.length !== claim.evidenceIds.length) {
		return {
			kind: 'invalid_evidence_reference',
			message: `已确认事实“${claim.text}”引用了不存在或不属于本案例的证据`
		};
	}
	// 内容支持必须不依赖来源确认：即使证据尚未被确认，也要先证明原文确实这么写。
	const content = findScopedSupport(claim.text, cited);
	if ('problem' in content) {
		return {
			kind: 'content_unsupported',
			message: `引用证据没有支持“${claim.text}”：${content.problem}`
		};
	}
	if (!cited.some(isConfirmedEvidence)) {
		return {
			kind: 'source_unconfirmed',
			message: `已确认事实“${claim.text}”必须引用正式通知，或引用用户标记为已确认的证据`
		};
	}
	return null;
}

function assertFactSupport(claim: BackgroundBoard['claims'][number], caseRecord: CaseRecord): void {
	const issue = evaluateFactSupport(claim, caseRecord);
	if (issue) throw new AgentSafetyError(issue.message);
}

export interface FactDowngrade {
	id: string;
	text: string;
	reason: string;
}

/**
 * 只降级“内容有依据、但来源尚未确认”的判断。
 *
 * 原文从未表达过的内容不允许降级保留：那会把一条被篡改的结论以“他人说法”
 * 的名义留在板上（例如原文说“不能领取钥匙”，结论写成“领取钥匙”）。
 * 这类问题必须让整轮判断失败，而不是静默改写。
 */
export function downgradeUnsupportedFacts(
	board: BackgroundBoard,
	caseRecord: CaseRecord
): { board: BackgroundBoard; downgrades: FactDowngrade[] } {
	const downgrades: FactDowngrade[] = [];
	const claims = board.claims.map((claim) => {
		const issue = evaluateFactSupport(claim, caseRecord);
		if (!issue || issue.kind !== 'source_unconfirmed') return claim;
		downgrades.push({ id: claim.id, text: claim.text, reason: issue.message });
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
