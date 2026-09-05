<script lang="ts">
	import type { AgentEvent } from '$lib/domain/types';
	let { events }: { events: AgentEvent[] } = $props();
	function label(event: AgentEvent): string {
		const payload = event.payload;
		if (event.type === 'case.demo') return '载入匿名宿舍案例';
		if (event.type === 'case.created') return '建立案例背景板';
		if (event.type === 'evidence.added') return '收到一条新证据';
		if (event.type === 'agent.fallback') return String(payload.summary ?? '载入审核结果');
		if (event.type === 'agent.finished') return String(payload.summary ?? '本轮判断结束');
		if (event.type === 'agent.action') {
			const action = String(payload.action ?? '判断');
			return (
				(
					{
						search_zhihu: '检索知乎相似经验',
						search_global: '检索外部资料',
						propose_board_patch: '重组背景板',
						ask_user: '提出关键追问',
						finish: '结束本轮判断'
					} as Record<string, string>
				)[action] ?? '执行判断'
			);
		}
		if (event.type === 'tool.result') return '工具结果已写回案例';
		return '案例状态更新';
	}
</script>

<section class="activity">
	<h2>Agent 动态</h2>
	<ul class="activity-list">
		{#each events.slice(-10).reverse() as event (event.id)}
			<li>
				<time
					>{new Date(event.createdAt).toLocaleTimeString('zh-CN', {
						hour: '2-digit',
						minute: '2-digit'
					})}</time
				><span>{label(event)}</span>
			</li>
		{/each}
	</ul>
</section>
