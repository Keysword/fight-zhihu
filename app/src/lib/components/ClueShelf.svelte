<script lang="ts">
	import type { ExternalClue } from '$lib/domain/types';
	let { clues }: { clues: ExternalClue[] } = $props();
</script>

{#if clues.length}
	<section class="clue-shelf">
		<h2>别人走过的路</h2>
		{#each clues as clue (clue.id)}
			<article class="clue">
				<a href={clue.url} target="_blank" rel="noreferrer">{clue.title}</a>
				<p>{clue.excerpt}</p>
				<span class="fine-print">{clue.warning}</span>
			</article>
		{/each}
	</section>
{/if}
