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

/**
 * 句子边界：否定、疑问与条件都按整句判定，顿号属于并列而非作用域边界。
 * 捕获组用于在切分时保留终止标点，否则“房间已经分配？”的问号会丢失。
 */
const SENTENCE_BOUNDARY = /([。；！？\n\r]+)/;

/**
 * 否定与排除词：在结论覆盖到的整句范围内判定。
 * 范围取整句而不是分句，是因为“禁止领取钥匙、领取门禁卡”里的禁止覆盖并列的两项。
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

/** 疑问与未确认转述：这类语境里的片段不构成独立断言。问号只在原文 raw 里可见。 */
const UNCERTAIN_MARKERS = [
	'？',
	'?',
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
	/** 原文片段（保留标点）：问号等语义标记只在原文里可见。 */
	raw: string;
	start: number;
	end: number;
}

/**
 * 句级单元：把终止标点保留在 raw 里，否则“房间已经分配？”的问号会随分割丢失。
 */
function sentenceUnits(text: string): TextUnit[] {
	const parts = text.split(SENTENCE_BOUNDARY);
	let offset = 0;
	const units: TextUnit[] = [];
	for (let index = 0; index < parts.length; index += 2) {
		const body = parts[index] ?? '';
		const terminator = parts[index + 1] ?? '';
		const packed = compact(body);
		if (packed.length === 0) continue;
		units.push({
			text: packed,
			raw: body + terminator,
			start: offset,
			end: offset + packed.length
		});
		offset += packed.length;
	}
	return units;
}

interface Candidate {
	/** 用于在原文里定位的连续文字。 */
	span: string;
	/** 被剥离的归属前缀；无剥离时为空串。 */
	prefix: string;
}

/**
 * 结论的候选匹配串。
 *
 * 逐字引用原文是最常见也最安全的写法；其次是加上“某某表示：”这类出处前缀。
 * 后者只剥离归属说明，且前缀必须真的出现在被引证据里——否则“物业说”会被
 * 改写成“财务表示”，归属就被伪造了。
 */
function candidateSpans(claimText: string): Candidate[] {
	const claim = compact(claimText);
	const candidates: Candidate[] = [{ span: claim, prefix: '' }];
	for (const verb of ATTRIBUTION_VERBS) {
		const marker = compact(verb);
		const at = claim.indexOf(marker);
		if (at <= 0) continue;
		const span = claim.slice(at + marker.length);
		const prefix = claim.slice(0, at);
		if (span.length < 2 || prefix.length === 0) continue;
		candidates.push({ span, prefix });
	}
	return candidates;
}

/**
 * 在证据原文里寻找一段能支撑该结论的独立断言，并返回实际支持它的证据。
 *
 * 结论必须作为原文中一段连续文字出现，且不能是从否定、疑问、条件或未确认
 * 转述的范围里截取出来的肯定片段。否定与疑问按**整句**判定：顿号是并列而
 * 不是作用域边界（“禁止领取钥匙、领取门禁卡”中的禁止覆盖两项）。这是一个
 * 保守的确定性规则，不声称解决任意自然语言语义：拿不准的语境一律拒绝。
 */
function findScopedSupport(
	claimText: string,
	evidenceList: Evidence[]
): { ok: true; evidenceId: string } | { problem: string } {
	const candidates = candidateSpans(claimText);
	if (candidates[0].span.length < 2) return { problem: '结论过短，无法与原文核对' };
	let unsafeScope: string | null = null;
	let unconfirmedSupport: string | null = null;
	for (const evidence of evidenceList) {
		const compactEvidence = compact(evidence.content);
		const sentences = sentenceUnits(evidence.content);
		for (const candidate of candidates) {
			if (candidate.prefix && !compactEvidence.includes(candidate.prefix)) {
				unsafeScope = `归属前缀“${candidate.prefix}”没有出现在引用证据里`;
				continue;
			}
			const at = compactEvidence.indexOf(candidate.span);
			if (at === -1) continue;
			const end = at + candidate.span.length;
			const covered = sentences.filter((unit) => unit.start < end && unit.end > at);
			const scopeMarker = [...NEGATION_MARKERS, ...UNCERTAIN_MARKERS].find(
				(marker) =>
					covered.some((unit) => unit.text.includes(marker) || unit.raw.includes(marker)) &&
					!candidate.span.includes(marker)
			);
			if (scopeMarker) {
				unsafeScope = `不能从否定、疑问或未确认的表述中截取（“${scopeMarker}”）`;
				continue;
			}
			const conditionMarker = CONDITION_MARKERS.find(
				(marker) =>
					covered.some((unit) => unit.text.includes(marker)) && !candidate.span.includes(marker)
			);
			if (conditionMarker) {
				unsafeScope = `不能从条件句里截取（“${conditionMarker}”）`;
				continue;
			}
			// 已确认的证据优先；否则先记下，等所有证据都试完再决定。
			if (isConfirmedEvidence(evidence)) return { ok: true, evidenceId: evidence.id };
			unconfirmedSupport ??= evidence.id;
		}
	}
	if (unconfirmedSupport) return { ok: true, evidenceId: unconfirmedSupport };
	return { problem: unsafeScope ?? '原文里没有出现这段连续文字' };
}

/**
 * 结构化判定一条 fact 是否成立；成立时返回 null。
 *
 * 三条都必须成立：内容确实出自某条引用证据、该证据本身已确认、结论没有引入
 * 原文没有的否定或疑问。第一与第二条必须落在**同一条证据**上——否则“未确认
 * 证据提供内容 + 另一条已确认证据提供确认”就能拼出一条事实。
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
	const content = findScopedSupport(claim.text, cited);
	if ('problem' in content) {
		return {
			kind: 'content_unsupported',
			message: `引用证据没有支持“${claim.text}”：${content.problem}`
		};
	}
	const supporter = cited.find((evidence) => evidence.id === content.evidenceId);
	if (!supporter) {
		return {
			kind: 'invalid_evidence_reference',
			message: `已确认事实“${claim.text}”引用了不存在或不属于本案例的证据`
		};
	}
	// 结论不得引入支持证据里没有的否定或疑问（例如把“物业说”写成“物业没有说”）。
	const claimCompact = compact(claim.text);
	const evidenceCompact = compact(supporter.content);
	const addedMarker = [...NEGATION_MARKERS, ...UNCERTAIN_MARKERS].find(
		(marker) => claimCompact.includes(marker) && !evidenceCompact.includes(marker)
	);
	if (addedMarker) {
		return {
			kind: 'content_unsupported',
			message: `引用证据没有支持“${claim.text}”：结论包含原文没有的否定或疑问（“${addedMarker}”）`
		};
	}
	if (!isConfirmedEvidence(supporter)) {
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
