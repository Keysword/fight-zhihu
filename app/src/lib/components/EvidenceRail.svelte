<script lang="ts">
	import type { Evidence } from '$lib/domain/types';
	let { evidence }: { evidence: Evidence[] } = $props();
	const kindLabels: Record<Evidence['kind'], string> = {
		message: '消息',
		email: '邮件',
		notice: '通知',
		call: '通话',
		note: '补充'
	};
</script>

<ul class="evidence-list">
	{#each evidence as item (item.id)}
		<li class="evidence-item">
			<div class="evidence-source">
				<span>{item.sourceLabel}</span><span>{kindLabels[item.kind]}</span>
			</div>
			<p>{item.content}</p>
		</li>
	{/each}
</ul>
