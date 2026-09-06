<script lang="ts">
	import type { NextAction } from '$lib/domain/types';
	let { action, changed = false }: { action: NextAction; changed?: boolean } = $props();
	let copied = $state(false);
	let draftMessage = $derived(action.message);
	async function copyMessage() {
		await navigator.clipboard.writeText(draftMessage);
		copied = true;
		setTimeout(() => (copied = false), 1600);
	}
</script>

<section class:changed class="next-action">
	<span class="kicker">现在可以这样问</span>
	<h3>{action.question}</h3>
	<p>{action.why}</p>
	<textarea
		class="message-paper editable-message"
		aria-label="可编辑的求助信息"
		bind:value={draftMessage}></textarea>
	<button class="button green" type="button" onclick={copyMessage}
		>{copied ? '已复制' : '复制这段话'}</button
	>
	{#if action.branches.length}
		<ul class="branch-list">
			{#each action.branches as branch (branch.when)}<li>
					<strong>{branch.when}：</strong>{branch.then}
				</li>{/each}
		</ul>
	{/if}
</section>
