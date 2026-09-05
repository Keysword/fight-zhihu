import type { BackgroundBoard, Evidence } from './types';

const at = '2026-08-01T08:00:00.000Z';

export const dormDemoEvidence: Evidence[] = [
	{
		id: 'evidence-contact',
		kind: 'message',
		content: '部门对接人：应该可以提前入住，我先申请。之后会有同事联系你，在门口接你。',
		sourceLabel: '部门对接人',
		occurredAt: at
	},
	{
		id: 'evidence-guide',
		kind: 'message',
		content: '接引同事：我可以带你进入园区，但我们看不到住宿分配结果，需要问物业。',
		sourceLabel: '接引同事',
		occurredAt: '2026-08-01T09:00:00.000Z'
	},
	{
		id: 'evidence-hr',
		kind: 'message',
		content: '人力：住宿结果以正式邮件通知为准。',
		sourceLabel: '人力老师',
		occurredAt: '2026-08-01T09:30:00.000Z'
	},
	{
		id: 'evidence-user',
		kind: 'note',
		content: '我计划在 8 月 2 日 16:00 到达，但目前没有收到房间号，也不知道钥匙由谁交付。',
		sourceLabel: '我的补充',
		occurredAt: '2026-08-01T10:00:00.000Z'
	}
];

export const dormDemoBoard: BackgroundBoard = {
	caseId: 'demo-dorm',
	title: '新人入住宿舍',
	goal: '确认 8 月 2 日到达后是否可以实际入住',
	stage: 'actionable',
	currentBlocker: '房间是否分配、钥匙由谁交付仍未得到负责方确认',
	claims: [
		{
			id: 'claim-eligibility',
			kind: 'unknown',
			text: '住宿资格尚未得到正式确认',
			evidenceIds: ['evidence-contact', 'evidence-hr'],
			rationale: '部门口头表示可以申请，但正式通知尚未到达'
		},
		{
			id: 'claim-room',
			kind: 'unknown',
			text: '房间是否已经分配仍然未知',
			evidenceIds: ['evidence-guide', 'evidence-user']
		},
		{
			id: 'claim-entry',
			kind: 'statement',
			text: '接引同事表示可以带新人进入园区',
			evidenceIds: ['evidence-guide']
		},
		{
			id: 'claim-key',
			kind: 'unknown',
			text: '当天钥匙是否可以领取、由谁交付仍然未知',
			evidenceIds: ['evidence-user']
		},
		{
			id: 'claim-notice',
			kind: 'statement',
			text: '人力表示正式通知以邮件为准',
			evidenceIds: ['evidence-hr']
		},
		{
			id: 'claim-conflict',
			kind: 'conflict',
			text: '已经安排接引并不等于已经具备实际入住条件',
			evidenceIds: ['evidence-contact', 'evidence-guide', 'evidence-hr', 'evidence-user'],
			relatedClaimIds: ['claim-entry', 'claim-room', 'claim-key']
		}
	],
	participants: [
		{
			id: 'participant-contact',
			name: '部门对接人',
			role: '协调新人到达安排',
			providedInfo: ['可以尝试申请提前入住', '将安排接引同事'],
			capabilities: ['联系部门同事'],
			decisionScopes: [],
			coordinationScopes: ['部门内部接引'],
			evidenceIds: ['evidence-contact']
		},
		{
			id: 'participant-guide',
			name: '接引同事',
			role: '带新人进入园区',
			providedInfo: ['无法查看住宿分配结果'],
			capabilities: ['执行入园接引'],
			decisionScopes: ['指定时间的接引安排'],
			coordinationScopes: [],
			evidenceIds: ['evidence-guide']
		},
		{
			id: 'participant-hr',
			name: '人力 / 住宿管理方',
			role: '负责住宿资格和正式通知',
			providedInfo: ['住宿结果以正式邮件为准'],
			capabilities: ['核对住宿资格', '查询正式通知状态'],
			decisionScopes: ['住宿资格与通知口径'],
			coordinationScopes: ['联系物业核实房间和钥匙'],
			evidenceIds: ['evidence-hr', 'evidence-guide']
		}
	],
	keyCompleter: {
		participantId: 'participant-hr',
		scope: '补全住宿资格、房间分配与钥匙交付状态',
		rationale: '人力负责正式通知，并且最有机会联系物业核实房间和钥匙状态',
		confidence: 'high',
		uncertainty: '现有材料不能证明人力已经查看过最终房间分配结果',
		evidenceIds: ['evidence-hr', 'evidence-guide']
	},
	nextAction: {
		contactParticipantId: 'participant-hr',
		question: '我的房间是否已经分配，当天钥匙由谁交付？',
		why: '这两项信息决定是否能够实际入住，也是当前唯一阻塞行动的缺口',
		message:
			'您好，我是即将入职的新员工，计划在 8 月 2 日 16:00 到达。目前部门同事已经安排接引，我也了解到住宿结果以正式邮件为准，但还没有收到房间分配和钥匙交付信息，因此无法判断当天是否可以实际入住。了解到您负责新员工住宿通知，并能协助联系物业，想请您帮我确认：我的房间是否已经分配、当天钥匙由谁交付？如果尚未分配，我就先不安排接引同事前往。谢谢。',
		branches: [
			{ when: '已经分配房间和钥匙', then: '确认房间号、交付人和到达时间后前往' },
			{ when: '尚未分配', then: '取消接引安排并询问预计通知时间' },
			{ when: '仍需询问物业', then: '请人力提供具体物业联系人或代为转交问题' }
		]
	},
	externalClues: [
		{
			id: 'clue-dorm-communication',
			title: '单位给新入职的安排了住宿，如何与单位沟通能有效获得宿舍？',
			excerpt: '相似经历提示：先说明已经掌握的安排，再向负责方确认具体住宿状态。',
			url: 'https://www.zhihu.com/question/428152303/answer/1572634952',
			author: '知乎用户',
			editedAt: null,
			authorityLevel: null,
			source: 'zhihu',
			relevance: '同为新人住宿确认与沟通问题',
			warning: '外部经验，仅供核实，不能代表当前单位安排'
		}
	],
	updatedAt: '2026-09-05T08:00:00.000Z'
};
