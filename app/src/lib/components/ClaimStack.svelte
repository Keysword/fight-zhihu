<script lang="ts">
	import type { Claim } from '$lib/domain/types';
	let { claims, changedIds = [] }: { claims: Claim[]; changedIds?: string[] } = $props();
	const labels: Record<Claim['kind'], string> = {
		fact: '已确认事实',
		statement: '对方说法',
		inference: 'Agent 推断',
		unknown: '仍然未知',
		conflict: '口径冲突'
	};
</script>

<div class="claim-stack">
	{#each claims as claim (claim.id)}
		<article class={`claim-slip ${claim.kind}`} class:changed={changedIds.includes(claim.id)}>
			<span class="claim-kind">{labels[claim.kind]} · {claim.evidenceIds.length} 条依据</span>
			<p>{claim.text}</p>
			{#if claim.rationale}<p class="claim-rationale">依据：{claim.rationale}</p>{/if}
		</article>
	{/each}
</div>
