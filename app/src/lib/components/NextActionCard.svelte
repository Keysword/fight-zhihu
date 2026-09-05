<script lang="ts">
	import type { NextAction } from '$lib/domain/types';
	let { action }: { action: NextAction } = $props();
	let copied = $state(false);
	async function copyMessage() {
		await navigator.clipboard.writeText(action.message);
		copied = true;
		setTimeout(() => (copied = false), 1600);
	}
</script>

<section class="next-action">
	<span class="kicker">现在可以这样问</span>
	<h3>{action.question}</h3>
	<p>{action.why}</p>
	<div class="message-paper">{action.message}</div>
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
