import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import type { CaseInputRequest, GuidanceDraft } from '$lib/domain/guidance';
import type { BackgroundBoard, ExternalClue } from '$lib/domain/types';
import { openDatabase } from '$lib/server/db';
import {
	createCaseRepository,
	GuidanceRunConflictError,
	IdempotencyConflictError,
	RevisionConflictError
} from './repository';

const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'background-board-'));
	temporaryDirectories.push(directory);
	return join(directory, 'cases.sqlite');
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function boardFor(caseId: string, title: string): BackgroundBoard {
	return {
		caseId,
		title,
		goal: '确认能否入住',
		stage: 'understanding',
		currentBlocker: '缺少房间分配信息',
		claims: [],
		participants: [],
		keyCompleter: null,
		nextAction: null,
		externalClues: [],
		updatedAt: new Date().toISOString()
	};
}

function guidanceRepository(path: string) {
	return createCaseRepository(path);
}

function guidanceDraft(summary: string): GuidanceDraft {
	return {
		understanding: { summary, openPoint: null, sources: [] },
		communicationChecks: [],
		nextStep: null,
		question: null,
		changeSummary: null
	};
}

function externalClue(id = 'clue-1'): ExternalClue {
	return {
		id,
		title: '官方办事指南',
		excerpt: '需要先核对通知',
		url: 'https://example.com/guide',
		author: '官方机构',
		editedAt: null,
		authorityLevel: '官方',
		source: 'global',
		relevance: '可用于核对流程',
		warning: '请以当期通知为准'
	};
}

describe('case repository', () => {
	it('creates a case, appends evidence, and records ordered events', () => {
		const repo = createCaseRepository(temporaryDatabasePath());
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间信息'
		});

		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '以邮件为准',
			sourceLabel: '同事',
			occurredAt: null
		});
		repo.appendEvent(created.id, { type: 'agent.action', payload: { tool: 'read_case' } });
		repo.appendEvent(created.id, { type: 'agent.finished', payload: { outcome: 'waiting' } });

		const loaded = repo.getCase(created.id);
		expect(loaded?.evidence).toEqual([evidence]);
		expect(repo.listCases()).toHaveLength(1);
		expect(repo.listEvents(created.id).map((event) => event.type)).toEqual([
			'agent.action',
			'agent.finished'
		]);
		repo.close();
	});

	it('appends canonical case input once and replays the same request without changing context', () => {
		const repo = guidanceRepository(temporaryDatabasePath());
		const created = repo.createCase({ title: '事项', goal: '解决问题', confusion: '背景不清' });
		const requestId = '00000000-0000-4000-8000-000000000001';

		const inserted = repo.appendCaseInput(created.id, {
			kind: 'context',
			content: '  新的背景信息  ',
			guidanceId: null,
			requestId
		});
		const replayed = repo.appendCaseInput(created.id, {
			kind: 'context',
			content: '新的背景信息',
			guidanceId: null,
			requestId
		});

		expect(inserted).toMatchObject({
			outcome: 'inserted',
			currentContextRevision: 1,
			input: {
				caseId: created.id,
				requestId,
				content: '新的背景信息',
				contextRevision: 1
			}
		});
		expect(replayed).toEqual({ ...inserted, outcome: 'replayed' });
		expect(repo.listCaseInputs(created.id)).toEqual([inserted.input]);
		expect(repo.getCaseContext(created.id)).toEqual({
			contextRevision: 1,
			currentGuidanceId: null
		});
		repo.close();
	});

	it('rejects a changed payload for a reused request id without changing state', () => {
		const repo = guidanceRepository(temporaryDatabasePath());
		const created = repo.createCase({ title: '事项', goal: '解决问题', confusion: '背景不清' });
		const requestId = '00000000-0000-4000-8000-000000000002';
		const first = repo.appendCaseInput(created.id, {
			kind: 'context',
			content: '原始内容',
			guidanceId: null,
			requestId
		});

		let conflict: unknown;
		try {
			repo.appendCaseInput(created.id, {
				kind: 'correction',
				content: '已修改内容',
				guidanceId: null,
				requestId
			});
		} catch (error) {
			conflict = error;
		}

		expect(conflict).toMatchObject({ name: 'IdempotencyConflictError' });
		expect(conflict).toBeInstanceOf(IdempotencyConflictError);
		expect(repo.listCaseInputs(created.id)).toEqual([first.input]);
		expect(repo.getCaseContext(created.id)).toEqual({
			contextRevision: 1,
			currentGuidanceId: null
		});
		repo.close();
	});

	it('allows different cases to reuse the same request id', () => {
		const repo = guidanceRepository(temporaryDatabasePath());
		const firstCase = repo.createCase({ title: '事项 A', goal: '解决问题', confusion: '背景不清' });
		const secondCase = repo.createCase({
			title: '事项 B',
			goal: '解决问题',
			confusion: '背景不清'
		});
		const requestId = '00000000-0000-4000-8000-000000000003';
		const request: CaseInputRequest = {
			kind: 'question',
			content: '接下来怎么做？',
			guidanceId: null,
			requestId
		};

		const first = repo.appendCaseInput(firstCase.id, request);
		const second = repo.appendCaseInput(secondCase.id, request);

		expect(first.outcome).toBe('inserted');
		expect(second.outcome).toBe('inserted');
		expect(first.input.id).not.toBe(second.input.id);
		expect(repo.getCaseContext(firstCase.id).contextRevision).toBe(1);
		expect(repo.getCaseContext(secondCase.id).contextRevision).toBe(1);
		repo.close();
	});

	it('keeps guidance snapshots while case inputs and evidence invalidate only the current pointer', () => {
		const repo = guidanceRepository(temporaryDatabasePath());
		const created = repo.createCase({ title: '事项', goal: '解决问题', confusion: '背景不清' });
		const first = repo.saveGuidance(
			created.id,
			0,
			guidanceDraft('初次理解'),
			[externalClue()],
			'10000000-0000-4000-8000-000000000001'
		);

		expect(first).toMatchObject({
			status: 'current',
			currentContextRevision: 0,
			currentGuidanceId: first.snapshot.id
		});
		expect(repo.getCurrentGuidance(created.id)).toEqual(first.snapshot);
		expect(repo.getGuidance(created.id, first.snapshot.id)?.externalClues).toEqual([
			externalClue()
		]);

		const inputRequest: CaseInputRequest = {
			kind: 'context',
			content: '补充的用户反馈',
			guidanceId: null,
			requestId: '10000000-0000-4000-8000-000000000002'
		};
		const input = repo.appendCaseInput(created.id, inputRequest);
		expect(input.currentContextRevision).toBe(1);
		expect(repo.getCurrentGuidance(created.id)).toBeNull();
		expect(repo.getGuidance(created.id, first.snapshot.id)).toEqual(first.snapshot);

		const second = repo.saveGuidance(
			created.id,
			1,
			guidanceDraft('基于反馈更新'),
			[],
			'10000000-0000-4000-8000-000000000003'
		);
		expect(second.status).toBe('current');
		const replay = repo.appendCaseInput(created.id, inputRequest);
		expect(replay.outcome).toBe('replayed');
		expect(repo.getCaseContext(created.id)).toEqual({
			contextRevision: 1,
			currentGuidanceId: second.snapshot.id
		});

		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '新的群聊消息',
			sourceLabel: '群聊',
			occurredAt: null
		});
		expect(repo.getCaseContext(created.id)).toEqual({
			contextRevision: 2,
			currentGuidanceId: null
		});

		const third = repo.saveGuidance(
			created.id,
			2,
			guidanceDraft('纳入新证据'),
			[],
			'10000000-0000-4000-8000-000000000004'
		);
		expect(third.status).toBe('current');
		repo.confirmEvidence(created.id, evidence.id);
		expect(repo.getCaseContext(created.id)).toEqual({
			contextRevision: 3,
			currentGuidanceId: null
		});
		expect(repo.listGuidance(created.id)).toEqual([
			first.snapshot,
			second.snapshot,
			third.snapshot
		]);
		expect(repo.getCase(created.id)?.revision).toBe(0);
		repo.close();
	});

	it('invalidates current guidance only when evidence confirmation changes', () => {
		const repo = guidanceRepository(temporaryDatabasePath());
		const created = repo.createCase({ title: '事项', goal: '解决问题', confusion: '背景不清' });
		const evidence = repo.appendEvidence(created.id, {
			kind: 'message',
			content: '待确认的消息',
			sourceLabel: '群聊',
			occurredAt: null
		});
		const beforeFirstConfirmation = repo.saveGuidance(
			created.id,
			1,
			guidanceDraft('待确认证据的指导'),
			[],
			'11000000-0000-4000-8000-000000000001'
		);

		expect(repo.confirmEvidence(created.id, evidence.id).confirmation).toBe('official');
		expect(repo.getCaseContext(created.id)).toEqual({
			contextRevision: 2,
			currentGuidanceId: null
		});
		expect(repo.getGuidance(created.id, beforeFirstConfirmation.snapshot.id)).toEqual(
			beforeFirstConfirmation.snapshot
		);

		const afterFirstConfirmation = repo.saveGuidance(
			created.id,
			2,
			guidanceDraft('已确认证据的指导'),
			[],
			'11000000-0000-4000-8000-000000000002'
		);
		expect(repo.confirmEvidence(created.id, evidence.id).confirmation).toBe('official');
		expect(repo.getCaseContext(created.id)).toEqual({
			contextRevision: 2,
			currentGuidanceId: afterFirstConfirmation.snapshot.id
		});
		expect(repo.getCurrentGuidance(created.id)).toEqual(afterFirstConfirmation.snapshot);
		repo.close();
	});

	it('stores stale runs as superseded history without replacing newer current guidance', () => {
		const repo = guidanceRepository(temporaryDatabasePath());
		const created = repo.createCase({ title: '事项', goal: '解决问题', confusion: '背景不清' });
		const capturedRevision = repo.getCaseContext(created.id).contextRevision;
		repo.appendCaseInput(created.id, {
			kind: 'context',
			content: '运行中到达的新信息',
			guidanceId: null,
			requestId: '20000000-0000-4000-8000-000000000001'
		});

		const firstStale = repo.saveGuidance(
			created.id,
			capturedRevision,
			guidanceDraft('旧上下文结果'),
			[],
			'20000000-0000-4000-8000-000000000002'
		);
		expect(firstStale).toMatchObject({
			status: 'superseded',
			currentContextRevision: 1,
			currentGuidanceId: null
		});
		expect(repo.getGuidance(created.id, firstStale.snapshot.id)).toEqual(firstStale.snapshot);

		const current = repo.saveGuidance(
			created.id,
			1,
			guidanceDraft('新上下文结果'),
			[],
			'20000000-0000-4000-8000-000000000003'
		);
		const laterStale = repo.saveGuidance(
			created.id,
			capturedRevision,
			guidanceDraft('更晚返回的旧结果'),
			[],
			'20000000-0000-4000-8000-000000000004'
		);

		expect(current.status).toBe('current');
		expect(laterStale).toMatchObject({
			status: 'superseded',
			currentContextRevision: 1,
			currentGuidanceId: current.snapshot.id
		});
		expect(repo.getCurrentGuidance(created.id)).toEqual(current.snapshot);
		expect(repo.listGuidance(created.id)).toEqual([
			firstStale.snapshot,
			current.snapshot,
			laterStale.snapshot
		]);
		repo.close();
	});

	it('scopes guidance reads, input references, and the current pointer to one case', () => {
		const path = temporaryDatabasePath();
		const repo = guidanceRepository(path);
		const firstCase = repo.createCase({ title: '事项 A', goal: '解决问题', confusion: '背景不清' });
		const secondCase = repo.createCase({
			title: '事项 B',
			goal: '解决问题',
			confusion: '背景不清'
		});
		const firstGuidance = repo.saveGuidance(
			firstCase.id,
			0,
			guidanceDraft('A 的建议'),
			[],
			'30000000-0000-4000-8000-000000000001'
		);

		expect(repo.getGuidance(secondCase.id, firstGuidance.snapshot.id)).toBeNull();
		expect(repo.listGuidance(secondCase.id)).toEqual([]);
		expect(() =>
			repo.appendCaseInput(secondCase.id, {
				kind: 'action_result',
				content: '已经按建议执行',
				guidanceId: firstGuidance.snapshot.id,
				requestId: '30000000-0000-4000-8000-000000000002'
			})
		).toThrow(/指导.*案例/);
		expect(repo.listCaseInputs(secondCase.id)).toEqual([]);
		expect(repo.getCaseContext(secondCase.id)).toEqual({
			contextRevision: 0,
			currentGuidanceId: null
		});

		const database = openDatabase(path);
		expect(() =>
			database
				.prepare('UPDATE cases SET current_guidance_id = ? WHERE id = ?')
				.run(firstGuidance.snapshot.id, secondCase.id)
		).toThrow(/current guidance must belong to case/);
		database.close();
		repo.close();
	});

	it('migrates a legacy database idempotently without changing legacy data or board revision', () => {
		const path = temporaryDatabasePath();
		const legacy = new DatabaseSync(path);
		legacy.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE cases (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				goal TEXT NOT NULL,
				confusion TEXT NOT NULL,
				stage TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 0,
				board_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE evidence (
				id TEXT PRIMARY KEY,
				case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				source_label TEXT NOT NULL,
				occurred_at TEXT,
				created_at TEXT NOT NULL
			);
			CREATE TABLE events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
				type TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
		`);
		const legacyCaseId = 'legacy-case';
		const createdAt = '2026-09-01T00:00:00.000Z';
		const legacyBoard = boardFor(legacyCaseId, '旧事项');
		legacy
			.prepare(
				'INSERT INTO cases (id, title, goal, confusion, stage, revision, board_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run(
				legacyCaseId,
				'旧事项',
				'保留旧目标',
				'保留旧困惑',
				'understanding',
				7,
				JSON.stringify(legacyBoard),
				createdAt,
				createdAt
			);
		legacy
			.prepare(
				'INSERT INTO evidence (id, case_id, kind, content, source_label, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
			)
			.run('legacy-evidence', legacyCaseId, 'notice', '旧通知', '官方', null, createdAt);
		legacy
			.prepare(
				'INSERT INTO events (id, case_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run(
				'legacy-event',
				legacyCaseId,
				'legacy.recorded',
				JSON.stringify({ kept: true }),
				createdAt
			);
		legacy.close();

		const firstOpen = guidanceRepository(path);
		const firstLoaded = firstOpen.getCase(legacyCaseId);
		expect(firstLoaded).toMatchObject({
			title: '旧事项',
			goal: '保留旧目标',
			confusion: '保留旧困惑',
			revision: 7,
			board: legacyBoard,
			evidence: [{ id: 'legacy-evidence', content: '旧通知', confirmation: 'official' }]
		});
		expect(firstOpen.listEvents(legacyCaseId)).toEqual([
			{
				id: 'legacy-event',
				caseId: legacyCaseId,
				type: 'legacy.recorded',
				payload: { kept: true },
				createdAt
			}
		]);
		expect(firstOpen.getCaseContext(legacyCaseId)).toEqual({
			contextRevision: 0,
			currentGuidanceId: null
		});
		firstOpen.close();

		const secondOpen = guidanceRepository(path);
		secondOpen.appendEvidence(legacyCaseId, {
			kind: 'note',
			content: '迁移后新证据',
			sourceLabel: '用户',
			occurredAt: null
		});
		expect(secondOpen.getCaseContext(legacyCaseId).contextRevision).toBe(1);
		expect(secondOpen.getCase(legacyCaseId)).toMatchObject({
			revision: 7,
			board: legacyBoard
		});
		expect(secondOpen.listCaseInputs(legacyCaseId)).toEqual([]);
		expect(secondOpen.listGuidance(legacyCaseId)).toEqual([]);
		secondOpen.close();
	});

	it('replays one run across repository connections and reports run conflicts without raw SQLite errors', () => {
		const path = temporaryDatabasePath();
		const firstRepo = guidanceRepository(path);
		const secondRepo = guidanceRepository(path);
		const firstCase = firstRepo.createCase({
			title: '事项 A',
			goal: '解决问题',
			confusion: '背景不清'
		});
		const secondCase = firstRepo.createCase({
			title: '事项 B',
			goal: '解决问题',
			confusion: '背景不清'
		});
		const runId = '40000000-0000-4000-8000-000000000001';
		const draft = guidanceDraft('共享运行结果');
		const saved = firstRepo.saveGuidance(firstCase.id, 0, draft, [externalClue()], runId);

		const replayed = secondRepo.saveGuidance(firstCase.id, 0, draft, [externalClue()], runId);
		expect(replayed).toEqual(saved);
		expect(secondRepo.listGuidance(firstCase.id)).toEqual([saved.snapshot]);

		for (const conflictingSave of [
			() =>
				secondRepo.saveGuidance(
					firstCase.id,
					0,
					guidanceDraft('同一 runId 的不同内容'),
					[externalClue()],
					runId
				),
			() => secondRepo.saveGuidance(secondCase.id, 0, draft, [externalClue()], runId)
		]) {
			let conflict: unknown;
			try {
				conflictingSave();
			} catch (error) {
				conflict = error;
			}
			expect(conflict).toMatchObject({ name: 'GuidanceRunConflictError' });
			expect(conflict).toBeInstanceOf(GuidanceRunConflictError);
			expect(String(conflict)).not.toMatch(/UNIQUE constraint failed/);
		}
		expect(secondRepo.listGuidance(secondCase.id)).toEqual([]);

		secondRepo.appendCaseInput(firstCase.id, {
			kind: 'context',
			content: '另一连接写入的上下文',
			guidanceId: null,
			requestId: '40000000-0000-4000-8000-000000000002'
		});
		const stale = firstRepo.saveGuidance(
			firstCase.id,
			0,
			guidanceDraft('第一连接的过期结果'),
			[],
			'40000000-0000-4000-8000-000000000003'
		);
		expect(stale).toMatchObject({
			status: 'superseded',
			currentContextRevision: 1,
			currentGuidanceId: null
		});
		expect(firstRepo.listGuidance(firstCase.id)).toHaveLength(2);
		secondRepo.close();
		firstRepo.close();
	});

	it('updates a board only at the expected revision', () => {
		const repo = createCaseRepository(temporaryDatabasePath());
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间信息'
		});

		const saved = repo.saveBoard(created.id, 0, boardFor(created.id, created.title));
		expect(saved.revision).toBe(1);
		expect(saved.board?.currentBlocker).toBe('缺少房间分配信息');
		expect(() => repo.saveBoard(created.id, 0, boardFor(created.id, created.title))).toThrow(
			RevisionConflictError
		);
		repo.close();
	});

	it('rejects a board for a different case', () => {
		const repo = createCaseRepository(temporaryDatabasePath());
		const created = repo.createCase({ title: '事项', goal: '解决问题', confusion: '背景不清' });
		expect(() => repo.saveBoard(created.id, 0, boardFor('another-case', '事项'))).toThrow(
			/案例不一致/
		);
		repo.close();
	});

	it('stages a proposal without replacing the current board until confirmation', () => {
		const repo = createCaseRepository(temporaryDatabasePath());
		const created = repo.createCase({
			title: '宿舍入住',
			goal: '确认能否入住',
			confusion: '没有房间信息'
		});
		const initial = boardFor(created.id, created.title);
		repo.saveBoard(created.id, 0, initial);
		const proposal = { ...initial, currentBlocker: '只差钥匙领取时间' };
		const staged = repo.stageBoardProposal(created.id, 1, proposal);
		expect(staged.revision).toBe(1);
		expect(staged.board?.currentBlocker).toBe('缺少房间分配信息');
		expect(staged.pendingBoard?.currentBlocker).toBe('只差钥匙领取时间');
		const confirmed = repo.confirmBoardProposal(created.id, 1);
		expect(confirmed.revision).toBe(2);
		expect(confirmed.board?.currentBlocker).toBe('只差钥匙领取时间');
		expect(confirmed.pendingBoard).toBeNull();
		repo.close();
	});
});
