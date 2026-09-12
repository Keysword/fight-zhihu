<script lang="ts">
	import type { CaseInput, GuidanceSnapshot, SourceRef } from '$lib/domain/guidance';
	import type { Evidence } from '$lib/domain/types';

	let {
		snapshot,
		evidence,
		inputs,
		stale = false,
		compact = false
	}: {
		snapshot: GuidanceSnapshot;
		evidence: Evidence[];
		inputs: CaseInput[];
		stale?: boolean;
		compact?: boolean;
	} = $props();

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	function source(ref: SourceRef) {
		if (ref.kind === 'evidence') {
			const item = evidence.find((candidate) => candidate.id === ref.id);
			return item ? { label: item.sourceLabel, text: item.content, url: null } : null;
		}
		if (ref.kind === 'input') {
			const item = inputs.find((candidate) => candidate.id === ref.id);
			return item ? { label: '你的补充', text: item.content, url: null } : null;
		}
		const item = snapshot.externalClues.find((candidate) => candidate.id === ref.id);
		return item ? { label: item.title, text: item.excerpt, url: item.url } : null;
	}

	function sourceItems(refs: SourceRef[]) {
		return refs.map(source).filter((item): item is NonNullable<typeof item> => item !== null);
	}

	async function copyMessage(message: string) {
		await navigator.clipboard.writeText(message);
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 1800);
	}
</script>

{#snippet sources(refs: SourceRef[])}
	{@const items = sourceItems(refs)}
	{#if items.length}
		<details class="guidance-sources">
			<summary>查看相关材料</summary>
			<div class="guidance-source-list">
				{#each items as item (`${item.label}:${item.text}`)}
					<blockquote>
						<strong>{item.label}</strong>
						<p>{item.text}</p>
						{#if item.url}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- validated external clue URL -->
							<a href={item.url} target="_blank" rel="noreferrer">打开原链接</a>
						{/if}
					</blockquote>
				{/each}
			</div>
		</details>
	{/if}
{/snippet}

<article class:compact class="guidance-panel">
	{#if stale}<p class="stale-guidance" role="status">这是补充前的理解</p>{/if}

	<section class="current-understanding">
		<h2>当前理解</h2>
		<p class="understanding-copy">{snapshot.draft.understanding.summary}</p>
		{#if snapshot.draft.understanding.openPoint}
			<p class="open-point">还没有弄清：{snapshot.draft.understanding.openPoint}</p>
		{/if}
		{@render sources(snapshot.draft.understanding.sources)}
	</section>

	{#if snapshot.draft.communicationChecks.length}
		<section class="communication-checks" aria-labelledby={`checks-${snapshot.id}`}>
			<h2 id={`checks-${snapshot.id}`}>值得核对的沟通疑点</h2>
			{#each snapshot.draft.communicationChecks as check (check.observation)}
				<article class="communication-note">
					<p>{check.observation}</p>
					<dl>
						<div>
							<dt>可能的误读</dt>
							<dd>{check.possibleMisreading}</dd>
						</div>
						<div>
							<dt>为什么要紧</dt>
							<dd>{check.whyItMatters}</dd>
						</div>
						<div>
							<dt>怎么核对</dt>
							<dd>{check.howToCheck}</dd>
						</div>
					</dl>
					{@render sources(check.sources)}
				</article>
			{/each}
		</section>
	{/if}

	{#if snapshot.draft.nextStep}
		{@const step = snapshot.draft.nextStep}
		<section class="guided-next-step">
			<h2>可以先试这一步</h2>
			<p class="next-instruction">{step.instruction}</p>
			<p>{step.why}</p>
			{#if step.contact}
				<div class="contact-note">
					<strong>{step.contact.label}</strong>
					<span
						>{step.contact.basis === 'suggested_role'
							? '可尝试的入口，尚未确认本单位职责'
							: '材料中出现的对象'}</span
					>
				</div>
				{@render sources(step.contact.sources)}
			{/if}
			{#if step.message}
				<div class="message-draft">
					<p>{step.message}</p>
					<button class="text-button" type="button" onclick={() => copyMessage(step.message ?? '')}>
						{copied ? '已复制到本机' : '复制这段话'}
					</button>
				</div>
			{/if}
			{#if step.branches.length}
				<ul class="guidance-branches">
					{#each step.branches as branch (branch.when)}<li>
							<strong>{branch.when}</strong>：{branch.then}
						</li>{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if snapshot.draft.question}
		<section class="model-question">
			<h2>还需要你补充</h2>
			<p>{snapshot.draft.question}</p>
		</section>
	{/if}
</article>
