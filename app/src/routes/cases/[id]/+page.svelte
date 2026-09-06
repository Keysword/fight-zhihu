<script lang="ts">
	import { base } from '$app/paths';
	import { diffBoards, type BoardChanges } from '$lib/domain/board-changes';
	import type { BackgroundBoard, EvidenceKind } from '$lib/domain/types';
	import { parseRedactionReplacements, redactText } from '$lib/privacy/redact';
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
	let proposedOverride = $state<BackgroundBoard | null | undefined>(undefined);
	let proposedBoard = $derived(
		proposedOverride === undefined ? (data.view.case.pendingBoard ?? null) : proposedOverride
	);
	let newEvidence = $state('');
	let newEvidenceKind = $state<EvidenceKind>('message');
	let sourceLabel = $state('我的补充');
	let replacementText = $state('');
	let evidenceConfirmed = $state(false);
	let loading = $state(false);
	let failure = $state('');
	let changesOverride = $state<BoardChanges | null>(null);
	let changes = $derived(
		changesOverride ?? diffBoards(data.view.case.board, data.view.case.pendingBoard ?? null)
	);
	let board = $derived(proposedBoard ?? view.case.board);
	let replacements = $derived(parseRedactionReplacements(replacementText).slice(0, 30));
	let evidencePreview = $derived(
		newEvidence
			? `来源：${redactText(sourceLabel, replacements).redacted}\n\n内容：${redactText(newEvidence, replacements).redacted}`
			: ''
	);

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
			const nextProposal =
				payload.data.run?.proposedBoard ?? payload.data.case.pendingBoard ?? null;
			changesOverride = diffBoards(view.case.board, nextProposal ?? payload.data.case.board);
			updatedView = { case: payload.data.case, events: payload.data.events };
			proposedOverride = nextProposal;
			newEvidence = '';
			if (payload.data.run?.outcome === 'failed') failure = payload.data.run.summary;
			if (!nextProposal) clearChangesLater();
		} catch (error) {
			failure = error instanceof Error ? error.message : '本轮判断没有完成';
		} finally {
			loading = false;
		}
	}

	function clearChangesLater() {
		setTimeout(() => (changesOverride = { blocker: false, claimIds: [], nextAction: false }), 5000);
	}

	async function reviewProposal(action: 'confirm' | 'discard') {
		if (!proposedBoard) return;
		loading = true;
		failure = '';
		try {
			const response = await fetch(`${base}/api/cases/${view.case.id}/proposal`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, expectedRevision: view.case.revision })
			});
			const payload = await response.json();
			if (!response.ok || !payload.ok)
				throw new Error(payload.error?.message ?? '没有完成这次审阅');
			updatedView = { case: payload.data.case, events: payload.data.events };
			proposedOverride = null;
			if (action === 'discard') {
				changesOverride = { blocker: false, claimIds: [], nextAction: false };
			} else {
				clearChangesLater();
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : '没有完成这次审阅';
		} finally {
			loading = false;
		}
	}

	async function addEvidence() {
		if (!newEvidence.trim() || !evidenceConfirmed) return;
		await refreshFrom(`${base}/api/cases/${view.case.id}/evidence`, {
			kind: newEvidenceKind,
			content: newEvidence,
			sourceLabel,
			replacements,
			occurredAt: null
		});
		replacementText = '';
		evidenceConfirmed = false;
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
				<ClaimStack
					claims={board.claims}
					evidence={view.case.evidence}
					changedIds={changes.claimIds}
				/>
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

	{#if proposedBoard}
		<section class="review-proposal" aria-label="待确认的背景板更新">
			<div>
				<span class="kicker">Agent 更新提案 · 尚未写入正式背景板</span>
				<h2>先检查上方高亮变化，再决定是否采用</h2>
				<p>原背景板仍安全保留。确认后才会生成第 {view.case.revision + 1} 次正式修订。</p>
			</div>
			<div class="review-actions">
				<button
					class="button green"
					type="button"
					disabled={loading}
					onclick={() => reviewProposal('confirm')}>确认并更新背景板</button
				>
				<button
					class="button secondary"
					type="button"
					disabled={loading}
					onclick={() => reviewProposal('discard')}>放弃这次归纳</button
				>
			</div>
		</section>
	{/if}

	<section class="composer">
		<h2>有新消息，继续补到这块板上</h2>
		<p class="fine-print">新证据会唤醒同一个案例 Agent；它会基于旧背景重新判断，不会从头失忆。</p>
		<div class="composer-row">
			<label>消息来源<input aria-label="消息来源" bind:value={sourceLabel} maxlength="120" /></label
			>
			<label
				>材料类型<select aria-label="材料类型" bind:value={newEvidenceKind}>
					<option value="message">聊天 / 回复</option>
					<option value="email">邮件</option>
					<option value="notice">正式通知</option>
					<option value="call">通话记录</option>
					<option value="note">个人笔记</option>
				</select></label
			>
		</div>
		<textarea
			aria-label="补充证据"
			bind:value={newEvidence}
			placeholder="例如：物业刚回复，房间已经分配，但钥匙需要在 18:00 前领取。"></textarea>
		<textarea
			class="replacement-input"
			aria-label="新证据中的敏感词替换"
			bind:value={replacementText}
			placeholder="可选：每行填写 原词 => 替换词"></textarea>
		{#if evidencePreview}
			<div class="preview-box compact-preview">
				<strong>本次外发预览</strong>\n\n{evidencePreview}
			</div>
			<label class="fine-print confirmation-line"
				><input type="checkbox" bind:checked={evidenceConfirmed} /> 我已检查这条新证据的脱敏预览</label
			>
		{/if}
		<button
			class="button"
			type="button"
			onclick={addEvidence}
			disabled={loading || !newEvidence.trim() || !evidenceConfirmed}
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
