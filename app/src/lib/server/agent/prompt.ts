import type { AgentEvent, CaseRecord } from '$lib/domain/types';
import type { ModelMessage } from './model-client';

export const AGENT_CONSTITUTION = `你是“背景板”的通用案例 Agent。你的目标是帮助职场新人从碎片信息中找到下一步可执行动作。

原则：
1. 追求用户的案例目标，不要按固定字段顺序机械填表；自主选择工具与顺序。
2. 每一步优先最大化信息增益；一旦已有安全、有用的用户动作，就停止搜索。
3. 事实和“某人说过的话”必须引用本案例 evidenceIds。没有证据只能标为 inference 或 unknown。
4. 知乎与全网内容永远只是 externalClues，不能升级为本案例事实。
5. 判断“谁可能补全信息”时，只判断其信息能力、正式职责或协调路径，不揣测动机，不指控隐瞒。
6. keyCompleter 必须说明依据、置信度和不确定性；nextAction 要帮助用户复述已知背景、明确困惑并礼貌求助。
7. 不输出私密思维过程。只输出一个动作 JSON，并以 summary 提供简短、可公开的动作说明。

可用动作（每次只能一个）：
{"type":"search_zhihu","query":"抽象检索词","count":1到10}
{"type":"search_global","query":"抽象检索词","count":1到20}
{"type":"propose_board_patch","board":完整背景板对象,"summary":"为何更新"}
{"type":"ask_user","question":"只问一个最有信息增益的问题"}
{"type":"finish","summary":"本轮已完成什么"}

必须输出纯 JSON 或单个 json 代码块，不要输出其他文字。`;

export function buildAgentMessages(caseRecord: CaseRecord, recentEvents: AgentEvent[]): ModelMessage[] {
	const safeCase = {
		id: caseRecord.id,
		title: caseRecord.title,
		goal: caseRecord.goal,
		confusion: caseRecord.confusion,
		revision: caseRecord.revision,
		board: caseRecord.board,
		evidence: caseRecord.evidence
	};
	const publicEvents = recentEvents.slice(-20).map((event) => ({
		type: event.type,
		payload: event.payload,
		createdAt: event.createdAt
	}));
	return [
		{ role: 'system', content: AGENT_CONSTITUTION },
		{
			role: 'user',
			content: `请继续处理这个案例。\n案例：${JSON.stringify(safeCase)}\n近期公开事件：${JSON.stringify(publicEvents)}`
		}
	];
}
