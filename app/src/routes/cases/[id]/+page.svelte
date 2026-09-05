<script lang="ts">
	import { base } from '$app/paths';
	import { diffBoards, type BoardChanges } from '$lib/domain/board-changes';
	import AgentActivity from '$lib/components/AgentActivity.svelte';
	import ClaimStack from '$lib/components/ClaimStack.svelte';
	import ClueShelf from '$lib/components/ClueShelf.svelte';
	import CompleterCard from '$lib/components/CompleterCard.svelte';
	import EvidenceRail from '$lib/components/EvidenceRail.svelte';
	import NextActionCard from '$lib/components/NextActionCard.svelte';
	import ParticipantCard from '$lib/components/ParticipantCard.svelte';
	import StageBadge from '$lib/components/StageBadge.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let updatedView = $state<PageData['view'] | null>(null);
	let view = $derived(updatedView ?? data.view);
	let newEvidence = $state('');
	let sourceLabel = $state('我的补充');
	let loading = $state(false);
	let failure = $state('');
	let changes = $state<BoardChanges>({ blocker: false, claimIds: [], nextAction: false });
	let board = $derived(view.case.board);

	async function refreshFrom(endpoint: string, body?: unknown) {
		loading = true;
		failure = '';
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined
			});
			const payload = await response.json();
			if (!response.ok || !payload.ok)
				throw new Error(payload.error?.message ?? '本轮判断没有完成');
			changes = diffBoards(view.case.board, payload.data.case.board);
			updatedView = { case: payload.data.case, events: payload.data.events };
			newEvidence = '';
			setTimeout(() => (changes = { blocker: false, claimIds: [], nextAction: false }), 5000);
		} catch (error) {
			failure = error instanceof Error ? error.message : '本轮判断没有完成';
		} finally {
			loading = false;
		}
	}

	async function addEvidence() {
		if (!newEvidence.trim()) return;
		await refreshFrom(`${base}/api/cases/${view.case.id}/evidence`, {
			kind: 'note',
			content: newEvidence,
			sourceLabel,
			occurredAt: null
		});
	}
</script>

<svelte:head><title>{view.case.title} · 背景板</title></svelte:head>

<main>
	<header class="case-head">
		<div class="case-meta">
			<StageBadge stage={view.case.stage} /><span>第 {view.case.revision} 次整理</span>
		</div>
		<h1>{view.case.title}</h1>
		<p class="goal-line"><strong>你想做到：</strong>{view.case.goal}</p>
	</header>

	{#if board}
		<section class:changed={changes.blocker} class="blocker-banner">
			<span>当前真正卡住的</span>
			<h2>{board.currentBlocker}</h2>
		</section>
		<div class="board-grid">
			<aside class="evidence-column">
				<h2 class="column-title">你掌握的证据 <span>{view.case.evidence.length} 条</span></h2>
				<EvidenceRail evidence={view.case.evidence} />
			</aside>
			<section class="understanding-column">
				<h2 class="column-title">背景是怎样拼起来的 <span>事实 / 未知 / 冲突</span></h2>
				<ClaimStack claims={board.claims} changedIds={changes.claimIds} />
				<div class="participant-list">
					{#each board.participants as participant (participant.id)}<ParticipantCard
							{participant}
						/>{/each}
				</div>
				<ClueShelf clues={board.externalClues} />
			</section>
			<aside class="action-column">
				<h2 class="column-title">把事情往前推 <span>判断与问法</span></h2>
				{#if board.keyCompleter}<CompleterCard
						completer={board.keyCompleter}
						participants={board.participants}
					/>{/if}
				{#if board.nextAction}<NextActionCard
						action={board.nextAction}
						changed={changes.nextAction}
					/>{/if}
				<AgentActivity events={view.events} />
			</aside>
		</div>
	{:else}
		<section class="empty-board">
			<h2>证据已经收好，背景板还没有形成</h2>
			<p class="muted">
				让 Agent 自主判断下一步；它可能整理背景、搜索相似经验，或只追问一个关键问题。
			</p>
			<button
				class="button"
				type="button"
				disabled={loading}
				onclick={() => refreshFrom(`${base}/api/cases/${view.case.id}/run`)}
				>{loading ? 'Agent 正在判断…' : '让 Agent 开始判断'}</button
			>
		</section>
	{/if}

	<section class="composer">
		<h2>有新消息，继续补到这块板上</h2>
		<p class="fine-print">新证据会唤醒同一个案例 Agent；它会基于旧背景重新判断，不会从头失忆。</p>
		<input aria-label="消息来源" bind:value={sourceLabel} maxlength="120" />
		<textarea
			aria-label="补充证据"
			bind:value={newEvidence}
			placeholder="例如：物业刚回复，房间已经分配，但钥匙需要在 18:00 前领取。"></textarea>
		<button
			class="button"
			type="button"
			onclick={addEvidence}
			disabled={loading || !newEvidence.trim()}
			>{loading ? '正在重新判断…' : '加入证据并继续判断'}</button
		>
		{#if failure}<div class="error-box" role="alert">{failure}</div>{/if}
		{#if changes.blocker || changes.claimIds.length || changes.nextAction}
			<p class="update-note" aria-live="polite">
				本次更新：{changes.blocker ? '阻塞点已变化；' : ''}{changes.claimIds.length
					? `${changes.claimIds.length} 条判断已变化；`
					: ''}{changes.nextAction ? '下一步行动已变化。' : ''}
			</p>
		{/if}
	</section>
</main>
