import {
	communicationCheckSchema,
	guidanceDraftSchema,
	nextStepSchema,
	textSchema,
	understandingCoreSchema,
	type DroppedGuidanceField,
	type GuidanceCompleteness,
	type GuidanceDraft,
	type SourceRef
} from '$lib/domain/guidance';

export interface AllowedSourceIds {
	evidence: ReadonlySet<string>;
	input: ReadonlySet<string>;
	external: ReadonlySet<string>;
}

export interface SalvageOutcome {
	draft: GuidanceDraft | null;
	completeness: GuidanceCompleteness;
	dropped: DroppedGuidanceField[];
}

const KNOWN_FIELDS = new Set([
	'understanding',
	'communicationChecks',
	'nextStep',
	'question',
	'changeSummary',
	'resolution'
]);

function isAllowed(source: SourceRef, allowed: AllowedSourceIds): boolean {
	if (source.kind === 'evidence') return allowed.evidence.has(source.id);
	if (source.kind === 'input') return allowed.input.has(source.id);
	return allowed.external.has(source.id);
}

function hasLocalSource(sources: readonly SourceRef[]): boolean {
	return sources.some((source) => source.kind === 'evidence' || source.kind === 'input');
}

function describe(sources: readonly SourceRef[]): string {
	return sources.map((source) => `${source.kind}:${source.id}`).join('，');
}

function partition(
	sources: readonly SourceRef[],
	allowed: AllowedSourceIds
): { kept: SourceRef[]; removed: SourceRef[] } {
	const kept: SourceRef[] = [];
	const removed: SourceRef[] = [];
	for (const source of sources) {
		if (isAllowed(source, allowed)) kept.push(source);
		else removed.push(source);
	}
	return { kept, removed };
}

function issueDetail(error: unknown): string {
	if (!(error && typeof error === 'object' && 'issues' in error)) return '不符合数据合同';
	const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues ?? [];
	const detail = issues
		.slice(0, 3)
		.map((issue) => `${(issue.path ?? []).join('.') || '(root)'}：${issue.message ?? '无效'}`)
		.join('；');
	return detail.slice(0, 600) || '不符合数据合同';
}

function parseBlock<T>(schema: { parse: (value: unknown) => T }, value: unknown): T | null {
	try {
		return schema.parse(value);
	} catch {
		return null;
	}
}

/**
 * Turns a raw model reply into the most useful draft it can still support.
 *
 * Illegal source ids are stripped rather than used to veto the whole reply, and each optional
 * block is parsed on its own so one bad block cannot discard a good understanding. Only a
 * missing `understanding.summary` is a real failure. This never widens what may be shown:
 * stripped references are gone, and a check that loses its last local source is dropped whole.
 */
export function salvageGuidance(raw: unknown, allowed: AllowedSourceIds): SalvageOutcome {
	const dropped: DroppedGuidanceField[] = [];
	const strict = parseBlock(guidanceDraftSchema, raw);
	const record = (raw ?? {}) as Record<string, unknown>;

	if (!strict) {
		const unknown = Object.keys(record).filter((key) => !KNOWN_FIELDS.has(key));
		if (unknown.length > 0) {
			dropped.push({
				field: 'unknownFields',
				reason: 'schema',
				detail: `剥离了合同外字段：${unknown.join('，')}`
			});
		}
	}

	const understandingSource = strict?.understanding ?? record.understanding;
	const understanding = parseBlock(understandingCoreSchema, understandingSource);
	if (!understanding) {
		return {
			draft: null,
			completeness: 'partial',
			dropped: [
				...dropped,
				{
					field: 'understanding.summary',
					reason: 'schema',
					detail: `缺少可用的当前理解：${issueDetail(
						safeError(() => understandingCoreSchema.parse(understandingSource))
					)}`
				}
			]
		};
	}

	if (!strict && understandingSource && typeof understandingSource === 'object') {
		const rawUnderstanding = understandingSource as Record<string, unknown>;
		if (rawUnderstanding.openPoint !== undefined && understanding.openPoint === null) {
			dropped.push({
				field: 'understanding.openPoint',
				reason: 'schema',
				detail: '未弄清事项的描述不符合数据合同，已丢弃'
			});
		}
	}

	const understandingSources = partition(understanding.sources, allowed);
	if (understandingSources.removed.length > 0) {
		dropped.push({
			field: 'understanding.sources',
			reason: 'reference',
			detail: `剔除了无效来源引用：${describe(understandingSources.removed)}`
		});
	}

	const rawChecks = strict?.communicationChecks ?? record.communicationChecks;
	const checks = salvageChecks(rawChecks, allowed, dropped);

	const question = salvageQuestion(strict, record, dropped);
	const nextStep = salvageNextStep(strict, record, allowed, question, dropped);
	const changeSummary = salvageOptionalText(
		strict ? strict.changeSummary : record.changeSummary,
		'changeSummary',
		Boolean(strict),
		dropped
	);

	const candidate = {
		understanding: {
			summary: understanding.summary,
			openPoint: understanding.openPoint,
			sources: understandingSources.kept
		},
		communicationChecks: checks,
		nextStep,
		question,
		changeSummary
	};

	const finalDraft = parseBlock(guidanceDraftSchema, candidate);
	if (!finalDraft) {
		// Reassembly must never emit an invalid draft; fall back to the necessary layer alone.
		const minimal = parseBlock(guidanceDraftSchema, {
			understanding: candidate.understanding,
			communicationChecks: [],
			nextStep: null,
			question: null,
			changeSummary: null
		});
		if (!minimal) return { draft: null, completeness: 'partial', dropped };
		return {
			draft: minimal,
			completeness: 'minimal',
			dropped: [
				...dropped,
				{ field: 'nextStep', reason: 'schema', detail: '各块无法组合为合法指导，仅保留当前理解' }
			]
		};
	}

	if (dropped.length === 0) return { draft: finalDraft, completeness: 'full', dropped };
	const onlyUnderstanding =
		finalDraft.communicationChecks.length === 0 &&
		finalDraft.nextStep === null &&
		finalDraft.question === null;
	return {
		draft: finalDraft,
		completeness: onlyUnderstanding ? 'minimal' : 'partial',
		dropped
	};
}

function safeError(run: () => unknown): unknown {
	try {
		run();
		return null;
	} catch (error) {
		return error;
	}
}

function salvageChecks(
	rawChecks: unknown,
	allowed: AllowedSourceIds,
	dropped: DroppedGuidanceField[]
): GuidanceDraft['communicationChecks'] {
	if (rawChecks === undefined || rawChecks === null) return [];
	if (!Array.isArray(rawChecks)) {
		dropped.push({
			field: 'communicationChecks',
			reason: 'schema',
			detail: '沟通疑点不是数组，已整块丢弃'
		});
		return [];
	}

	const kept: GuidanceDraft['communicationChecks'] = [];
	rawChecks.forEach((item, index) => {
		const parsed = parseBlock(communicationCheckSchema, item);
		if (!parsed) {
			dropped.push({
				field: 'communicationChecks',
				reason: 'schema',
				detail: `第 ${index + 1} 条疑点不符合数据合同：${issueDetail(
					safeError(() => communicationCheckSchema.parse(item))
				)}`
			});
			return;
		}
		const sources = partition(parsed.sources, allowed);
		if (!hasLocalSource(sources.kept)) {
			dropped.push({
				field: 'communicationChecks',
				reason: sources.removed.length > 0 ? 'reference' : 'schema',
				detail:
					sources.removed.length > 0
						? `第 ${index + 1} 条疑点剔除无效引用后不再有本案例来源，已丢弃该条：${describe(sources.removed)}`
						: `第 ${index + 1} 条疑点没有本案例来源，已丢弃该条`
			});
			return;
		}
		if (kept.length >= 2) {
			dropped.push({
				field: 'communicationChecks',
				reason: 'schema',
				detail: `超出两条上限，丢弃第 ${index + 1} 条疑点`
			});
			return;
		}
		kept.push({ ...parsed, sources: sources.kept });
	});
	return kept;
}

function salvageQuestion(
	strict: GuidanceDraft | null,
	record: Record<string, unknown>,
	dropped: DroppedGuidanceField[]
): string | null {
	if (strict) return strict.question;
	return salvageOptionalText(record.question, 'question', false, dropped);
}

function salvageOptionalText(
	value: unknown,
	field: 'question' | 'changeSummary',
	trusted: boolean,
	dropped: DroppedGuidanceField[]
): string | null {
	if (trusted) return (value as string | null) ?? null;
	if (value === undefined || value === null) return null;
	const parsed = parseBlock(textSchema, value);
	if (parsed === null) {
		dropped.push({ field, reason: 'schema', detail: `${field} 不符合数据合同，已丢弃` });
		return null;
	}
	return parsed;
}

function salvageNextStep(
	strict: GuidanceDraft | null,
	record: Record<string, unknown>,
	allowed: AllowedSourceIds,
	question: string | null,
	dropped: DroppedGuidanceField[]
): GuidanceDraft['nextStep'] {
	const rawStep = strict ? strict.nextStep : record.nextStep;
	if (rawStep === undefined || rawStep === null) return null;

	const parsed = strict?.nextStep ?? parseBlock(nextStepSchema, rawStep);
	if (!parsed) {
		dropped.push({
			field: 'nextStep',
			reason: 'schema',
			detail: `下一步不符合数据合同：${issueDetail(safeError(() => nextStepSchema.parse(rawStep)))}`
		});
		return null;
	}

	if (parsed.kind === 'answer' && question === null) {
		dropped.push({
			field: 'nextStep',
			reason: 'schema',
			detail: 'answer 动作缺少对应问题，已丢弃下一步'
		});
		return null;
	}

	let contact = parsed.contact;
	if (contact) {
		const sources = partition(contact.sources, allowed);
		if (sources.removed.length > 0) {
			if (contact.basis === 'case_material' && !hasLocalSource(sources.kept)) {
				if (parsed.kind === 'contact') {
					dropped.push({
						field: 'nextStep',
						reason: 'reference',
						detail: `联系人来源引用无效且该动作必须指定联系人，已丢弃下一步：${describe(sources.removed)}`
					});
					return null;
				}
				dropped.push({
					field: 'nextStep',
					reason: 'reference',
					detail: `联系人来源引用无效，已移除联系人：${describe(sources.removed)}`
				});
				contact = null;
			} else {
				dropped.push({
					field: 'nextStep',
					reason: 'reference',
					detail: `剔除了联系人的无效来源引用：${describe(sources.removed)}`
				});
				contact = { ...contact, sources: sources.kept };
			}
		}
	}

	return { ...parsed, contact };
}
