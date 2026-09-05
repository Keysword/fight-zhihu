import { dormDemoBoard, dormDemoEvidence } from '$lib/domain/demo-case';
import type { BackgroundBoard, CaseRecord } from '$lib/domain/types';

export function buildDormDemoFallback(caseRecord: CaseRecord): BackgroundBoard | null {
	const idMap = new Map<string, string>();
	for (const fixture of dormDemoEvidence) {
		const actual = caseRecord.evidence.find(
			(evidence) =>
				evidence.sourceLabel === fixture.sourceLabel && evidence.content === fixture.content
		);
		if (!actual) return null;
		idMap.set(fixture.id, actual.id);
	}

	const board = structuredClone(dormDemoBoard);
	const mapIds = (ids: string[]) => ids.map((id) => idMap.get(id) ?? id);
	board.caseId = caseRecord.id;
	board.title = caseRecord.title;
	board.goal = caseRecord.goal;
	board.updatedAt = new Date().toISOString();
	for (const claim of board.claims) claim.evidenceIds = mapIds(claim.evidenceIds);
	for (const participant of board.participants)
		participant.evidenceIds = mapIds(participant.evidenceIds);
	if (board.keyCompleter) board.keyCompleter.evidenceIds = mapIds(board.keyCompleter.evidenceIds);

	const propertyReply = caseRecord.evidence.find(
		(evidence) =>
			!dormDemoEvidence.some(
				(fixture) =>
					fixture.sourceLabel === evidence.sourceLabel && fixture.content === evidence.content
			) &&
			/房间.{0,8}(?:已经|已)?分配/.test(evidence.content) &&
			/钥匙.{0,10}(?:前台|领取|交付)/.test(evidence.content)
	);
	if (propertyReply) applyPropertyReply(board, propertyReply.id);
	return board;
}

function applyPropertyReply(board: BackgroundBoard, evidenceId: string): void {
	board.stage = 'actionable';
	board.currentBlocker = '房间与钥匙位置已经补全，需要确认到达时间和前台领取细节';
	board.claims = board.claims.map((claim) => {
		if (claim.id === 'claim-room') {
			return {
				...claim,
				kind: 'statement',
				text: '物业回复房间已经分配',
				evidenceIds: [evidenceId],
				rationale: '这是用户补充的物业回复，仍保留为可追溯的对方说法'
			};
		}
		if (claim.id === 'claim-key') {
			return {
				...claim,
				kind: 'statement',
				text: '物业回复钥匙在前台领取',
				evidenceIds: [evidenceId],
				rationale: '领取地点已获得回复，到达时间和交付细节仍可进一步确认'
			};
		}
		if (claim.id === 'claim-conflict') {
			return {
				...claim,
				kind: 'inference',
				text: '接引、房间和钥匙三项信息现在可以组成可执行的入住安排',
				evidenceIds: [...claim.evidenceIds, evidenceId],
				rationale: '新增物业回复补上了原先缺失的房间分配和钥匙位置'
			};
		}
		return claim;
	});
	board.participants.push({
		id: 'participant-property',
		name: '物业 / 宿舍前台',
		role: '房间与钥匙交付经办方',
		providedInfo: ['房间已经分配', '钥匙在前台领取'],
		capabilities: ['核对房间状态', '说明钥匙领取细节'],
		decisionScopes: ['房间分配与钥匙交付'],
		coordinationScopes: ['前台领取安排'],
		evidenceIds: [evidenceId]
	});
	board.keyCompleter = {
		participantId: 'participant-property',
		scope: '确认到达时段、房间号和钥匙领取细节',
		rationale: '物业已经直接提供房间和钥匙信息，是当前最接近实际交付环节的人',
		confidence: 'high',
		uncertainty: '现有回复没有写明 8 月 2 日 16:00 前台是否开放，也没有记录房间号',
		evidenceIds: [evidenceId]
	};
	board.nextAction = {
		contactParticipantId: 'participant-property',
		question: '请确认 8 月 2 日 16:00 到达时可以在前台领取钥匙吗？',
		why: '房间和领取地点已经明确，只需补齐到达时段与交付细节即可执行',
		message:
			'您好，我计划在 8 月 2 日 16:00 到达，目前已经确认房间完成分配、钥匙在前台领取，也有同事安排接引。为了避免到达后无法交接，想请您再帮我确认：当天 16:00 前台是否可以领取钥匙，以及是否需要提供房间号或其他材料？谢谢。',
		branches: [
			{ when: '该时段可以领取', then: '记录房间号和所需材料，按接引安排前往' },
			{ when: '该时段无法领取', then: '调整到达时间或确认代领、值班交接方式' }
		]
	};
}
