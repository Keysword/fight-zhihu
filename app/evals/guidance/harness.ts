import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	appendFileSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION as SDK_VERSION } from 'openai';

import type { GuidanceSnapshot } from '$lib/domain/guidance';
import { createCaseRepository, type CaseRepository } from '$lib/server/cases/repository';
import { createModelClient, type ModelClient } from '$lib/server/agent/model-client';
import { createSdkModelClient } from '$lib/server/agent/sdk-model-client';
import { createZhihuClient, type ZhihuClient } from '$lib/server/zhihu/client';
import scenarioFile from './latency-cases.json';

export type EvaluationPhase = 'smoke' | 'transport' | 'policy' | 'search';

export interface LatencyScenario {
	id: string;
	title: string;
	goal: string;
	confusion: string;
	evidence: Array<{ sourceLabel: string; content: string }>;
	inputs: Array<{
		kind: 'context' | 'correction' | 'constraint' | 'action_result' | 'question';
		content: string;
	}>;
	shouldFocus: string[];
	mustAvoid: string[];
}

export const latencyScenarios = scenarioFile.cases as LatencyScenario[];
export const scenarioById = new Map(latencyScenarios.map((scenario) => [scenario.id, scenario]));

export interface EvaluationRow {
	sampleId: string;
	phase: EvaluationPhase;
	arm: string;
	caseId: string;
	repeat: number;
	commit: string;
	sdkVersion: string;
	modelLabel: string;
	promptHash: string;
	configurationHash: string;
	outcome: string;
	totalMs: number;
	queueMs: number;
	modelAttempts: number;
	logicalSteps: number;
	searchRequests: number;
	searchCacheHits: number;
	repairCount: number;
	firstContentMs: number | null;
	errorCode: string | null;
}

interface Ledger {
	modelRequests: number;
	searchRequests: number;
	updatedAt: string;
}

export class BudgetExhaustedError extends Error {
	constructor(kind: 'model' | 'search') {
		super(kind === 'model' ? '模型请求预算已用尽' : '搜索请求预算已用尽');
		this.name = 'BudgetExhaustedError';
	}
}

const dataDirectory = fileURLToPath(
	new URL('../../../docs/superpowers/reports/data/sdk-personal-agent/', import.meta.url)
);
const ledgerPath = join(dataDirectory, 'ledger.json');

function readLedger(): Ledger {
	if (!existsSync(ledgerPath)) return { modelRequests: 0, searchRequests: 0, updatedAt: '' };
	return JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
}

function writeLedger(ledger: Ledger): void {
	mkdirSync(dataDirectory, { recursive: true });
	ledger.updatedAt = new Date().toISOString();
	writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

/** gitignored、0600 的评测凭证文件；键值注入 process.env，不写入任何报告。 */
function loadEvalEnvFile(): void {
	const candidate = resolve(process.cwd(), '.env.eval');
	if (!existsSync(candidate)) return;
	for (const line of readFileSync(candidate, 'utf8').split('\n')) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
		if (!match) continue;
		const [, name, value] = match;
		if (!(name in process.env)) process.env[name] = value;
	}
}

function shortHash(payload: unknown): string {
	return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

function currentCommit(): string {
	try {
		return execSync('git rev-parse --short HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

export interface ArmDefinition {
	name: string;
	/** 'sdk' | 'legacy-http' | 'opencode' | 'none'（未配置） */
	transport: 'sdk' | 'legacy-http' | 'opencode' | 'none';
	modelLabel: string;
	/** 交给 configurationHash 的非敏感配置；密钥绝不进入。 */
	configuration: Record<string, unknown>;
	createClient: (options: { onModelRequest: () => void }) => ModelClient | null;
}

/** SDK 直连臂（openai 兼容端点）。 */
function sdkArm(armName: string, stream: boolean): ArmDefinition {
	const baseURL = process.env.AGENT_SDK_BASE_URL ?? '';
	const apiKey = process.env.AGENT_API_KEY ?? '';
	const model = process.env.AGENT_MODEL ?? '';
	const configured = Boolean(baseURL && apiKey && model);
	return {
		name: armName,
		transport: configured ? 'sdk' : 'none',
		modelLabel: configured ? model : 'unconfigured',
		configuration: { transport: 'sdk', baseURL, model, stream },
		createClient: ({ onModelRequest }) => {
			if (!configured) return null;
			const inner = createSdkModelClient({ baseURL, apiKey, model, stream });
			return {
				complete: (messages, options) => {
					onModelRequest();
					return inner.complete(messages, options);
				}
			};
		}
	};
}

/** legacy-http 臂：同一端点走旧手写 fetch 链路。 */
function legacyHttpArm(): ArmDefinition {
	const url = process.env.AGENT_API_URL ?? '';
	const apiKey = process.env.AGENT_API_KEY ?? '';
	const model = process.env.AGENT_MODEL ?? '';
	const configured = Boolean(url && model);
	return {
		name: 'legacy-http',
		transport: configured ? 'legacy-http' : 'none',
		modelLabel: configured ? model : 'unconfigured',
		configuration: { transport: 'legacy-http', url, model },
		createClient: ({ onModelRequest }) => {
			if (!configured) return null;
			const inner = createModelClient({ url, apiKey, model, isZhihu: false });
			return {
				complete: (messages, options) => {
					onModelRequest();
					return inner.complete(messages, options);
				}
			};
		}
	};
}

/** OpenCode 臂：路径对照；底层模型参数未知，报告需标注混杂。 */
function opencodeArm(): ArmDefinition {
	const url = process.env.OPENCODE_SERVER_URL ?? '';
	const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
	const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
	const configured = Boolean(url && password);
	return {
		name: 'opencode',
		transport: configured ? 'opencode' : 'none',
		modelLabel: configured ? 'server-default' : 'unconfigured',
		configuration: { transport: 'opencode', url },
		createClient: ({ onModelRequest }) => {
			if (!configured) return null;
			const inner = createModelClient({
				url,
				apiKey: password,
				model: 'server-default',
				isZhihu: false,
				protocol: 'opencode',
				username
			});
			return {
				complete: (messages, options) => {
					// OpenCode 的建/删 session 不算模型请求；message 请求要计数。
					onModelRequest();
					return inner.complete(messages, options);
				}
			};
		}
	};
}

export function armsForTransportPhase(): ArmDefinition[] {
	return [legacyHttpArm(), sdkArm('sdk-nonstream', false), opencodeArm()];
}

export function sdkOnlyArms(): ArmDefinition[] {
	return [sdkArm('sdk-nonstream', false), sdkArm('sdk-stream', true)];
}

export interface ZhihuCounter {
	client: ZhihuClient;
	requests: () => number;
}

export function countedZhihuClient(limit: number, onLimit: () => never): ZhihuCounter {
	const inner = process.env.ZHIHU_ACCESS_SECRET
		? createZhihuClient({ accessSecret: process.env.ZHIHU_ACCESS_SECRET })
		: null;
	let requests = 0;
	const countedSearch =
		(method: 'searchZhihu' | 'searchGlobal') => async (query: string, count?: number) => {
			if (!inner) throw new Error('ZHIHU_ACCESS_SECRET 未配置，无法执行真实搜索');
			if (requests + 1 > limit) throw onLimit();
			requests += 1;
			return inner[method](query, count);
		};
	return {
		client: {
			searchZhihu: countedSearch('searchZhihu'),
			searchGlobal: countedSearch('searchGlobal')
		},
		requests: () => requests
	};
}

export interface EvalSessionOptions {
	phase: EvaluationPhase;
	/** 本次运行允许新增的模型请求上限；必须落在全局限额之内。 */
	maxModelRequests?: number;
	maxSearchRequests?: number;
}

export class EvalSession {
	readonly phase: EvaluationPhase;
	readonly commit: string;
	readonly sdkVersion: string;
	readonly dataDir: string;
	private readonly ledger: Ledger;
	private readonly globalModelLimit: number;
	private readonly globalSearchLimit: number;
	private readonly runModelLimit: number;
	private readonly runSearchLimit: number;
	private usedModelRequests = 0;
	private usedSearchRequests = 0;
	private readonly rows: EvaluationRow[] = [];

	constructor(options: EvalSessionOptions) {
		loadEvalEnvFile();
		this.phase = options.phase;
		this.commit = currentCommit();
		this.sdkVersion = SDK_VERSION;
		this.dataDir = dataDirectory;
		this.globalModelLimit = positiveInt(process.env.GUIDANCE_EVAL_MODEL_LIMIT, 150);
		this.globalSearchLimit = positiveInt(process.env.GUIDANCE_EVAL_SEARCH_LIMIT, 30);
		this.runModelLimit = options.maxModelRequests ?? this.globalModelLimit;
		this.runSearchLimit = options.maxSearchRequests ?? this.globalSearchLimit;
		this.ledger = readLedger();
		mkdirSync(join(dataDirectory, 'outputs'), { recursive: true });
		mkdirSync(join(dataDirectory, 'attempts'), { recursive: true });
	}

	get remainingModelRequests(): number {
		return Math.min(
			this.runModelLimit - this.usedModelRequests,
			this.globalModelLimit - this.ledger.modelRequests
		);
	}

	get remainingSearchRequests(): number {
		return Math.min(
			this.runSearchLimit - this.usedSearchRequests,
			this.globalSearchLimit - this.ledger.searchRequests
		);
	}

	/** 出站请求边界计数：失败也计入。 */
	reserveModelRequests(count: number): void {
		if (this.remainingModelRequests < count) throw new BudgetExhaustedError('model');
		this.usedModelRequests += count;
		this.ledger.modelRequests += count;
		writeLedger(this.ledger);
	}

	reserveSearchRequests(count: number): void {
		if (this.remainingSearchRequests < count) throw new BudgetExhaustedError('search');
		this.usedSearchRequests += count;
		this.ledger.searchRequests += count;
		writeLedger(this.ledger);
	}

	/** 模型臂工厂：包装计数与预算。 */
	modelClientFor(arm: ArmDefinition, timeoutMs: number): ModelClient | null {
		const reserve = (count: number): void => this.reserveModelRequests(count);
		const inner = arm.createClient({
			onModelRequest: () => reserve(1)
		});
		if (!inner) return null;
		return {
			complete: (messages, options) =>
				inner.complete(messages, { ...options, timeoutMs: options?.timeoutMs ?? timeoutMs })
		};
	}

	recordRow(row: EvaluationRow): void {
		this.rows.push(row);
		appendFileSync(join(dataDirectory, `results-${this.phase}.jsonl`), `${JSON.stringify(row)}\n`);
	}

	recordAttempts(sampleId: string, finishedPayload: Record<string, unknown>): void {
		// 完整逐 attempt 元数据：只含计数、耗时与错误分类，不含 prompt/密钥/正文。
		appendFileSync(
			join(dataDirectory, 'attempts', `attempts-${this.phase}.jsonl`),
			`${JSON.stringify({ sampleId, ...finishedPayload })}\n`
		);
	}

	recordOutput(
		phase: string,
		arm: string,
		scenarioId: string,
		repeat: number,
		snapshot: GuidanceSnapshot | null
	): void {
		const directory = join(dataDirectory, 'outputs', phase);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, `${arm}-${scenarioId}-r${repeat}.json`),
			JSON.stringify(snapshot ? snapshot.draft : { outcome: 'no-guidance' }, null, 2)
		);
	}

	summary(): Record<string, unknown> {
		return {
			phase: this.phase,
			commit: this.commit,
			sdkVersion: this.sdkVersion,
			modelRequestsUsed: this.usedModelRequests,
			searchRequestsUsed: this.usedSearchRequests,
			ledger: readLedger(),
			rows: this.rows.length
		};
	}
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export interface MaterialisedCase {
	caseId: string;
	scenario: LatencyScenario;
	promptHash: string;
}

/** 把合成场景写入隔离 SQLite；每次调用独立 mkdtemp，绝不复用 app/data。 */
export function materialiseScenario(
	repository: CaseRepository,
	scenario: LatencyScenario
): MaterialisedCase {
	const created = repository.createCase({
		title: scenario.title,
		goal: scenario.goal,
		confusion: scenario.confusion
	});
	for (const evidence of scenario.evidence) {
		repository.appendEvidence(created.id, {
			kind: 'notice',
			content: evidence.content,
			sourceLabel: evidence.sourceLabel,
			occurredAt: null
		});
	}
	for (const input of scenario.inputs) {
		repository.appendCaseInput(created.id, {
			kind: input.kind,
			content: input.content,
			guidanceId: null,
			requestId: randomUUID()
		});
	}
	return { caseId: created.id, scenario, promptHash: shortHash(scenario) };
}

export function isolatedRepository(): CaseRepository {
	const directory = mkdtempSync(join(tmpdir(), 'guidance-eval-'));
	return createCaseRepository(join(directory, 'cases.sqlite'));
}

export { shortHash as configurationHashOf };
