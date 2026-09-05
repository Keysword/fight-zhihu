<script lang="ts">
	import type { Participant } from '$lib/domain/types';
	let { participant }: { participant: Participant } = $props();
</script>

<article class="participant-card">
	<h3>{participant.name}</h3>
	<p>{participant.role}</p>
	{#if participant.capabilities.length}
		<ul>
			{#each participant.capabilities as item (item)}<li>{item}</li>{/each}
		</ul>
	{/if}
</article>
