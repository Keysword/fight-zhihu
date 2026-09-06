<script lang="ts">
	import type { ExternalClue } from '$lib/domain/types';
	let { clues }: { clues: ExternalClue[] } = $props();
	function dateLabel(value: string | null): string {
		return value ? new Date(value).toLocaleDateString('zh-CN') : '时间未知';
	}
	function stale(value: string | null): boolean {
		return Boolean(value && Date.now() - new Date(value).getTime() > 365 * 24 * 60 * 60 * 1000);
	}
</script>

{#if clues.length}
	<section class="clue-shelf">
		<h2>别人走过的路</h2>
		{#each clues as clue (clue.id)}
			<article class="clue">
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- validated external clue URL -->
				<a href={clue.url} target="_blank" rel="noreferrer">{clue.title}</a>
				<p>{clue.excerpt}</p>
				<p class="clue-meta">
					{clue.author || '作者未知'} · {dateLabel(clue.editedAt)}{clue.authorityLevel
						? ` · 来源等级 ${clue.authorityLevel}`
						: ''}
				</p>
				{#if clue.relevance}<p><strong>可借鉴：</strong>{clue.relevance}</p>{/if}
				<span class="fine-print">{clue.warning}</span>
				{#if stale(clue.editedAt)}<span class="stale-clue">发布时间超过一年，信息可能已变化</span
					>{/if}
			</article>
		{/each}
	</section>
{/if}
