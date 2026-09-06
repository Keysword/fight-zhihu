<script lang="ts">
	import type { Claim, Evidence } from '$lib/domain/types';
	let {
		claims,
		evidence,
		changedIds = []
	}: { claims: Claim[]; evidence: Evidence[]; changedIds?: string[] } = $props();
	let evidenceById = $derived(new Map(evidence.map((item) => [item.id, item])));
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
			{#if claim.evidenceIds.length}
				<details class="claim-evidence">
					<summary>查看 {claim.evidenceIds.length} 条原始证据</summary>
					{#each claim.evidenceIds as evidenceId (evidenceId)}
						{@const item = evidenceById.get(evidenceId)}
						{#if item}
							<blockquote>
								<strong>{item.sourceLabel}</strong>
								<p>{item.content}</p>
							</blockquote>
						{/if}
					{/each}
				</details>
			{/if}
		</article>
	{/each}
</div>
