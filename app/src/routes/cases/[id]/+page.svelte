<script lang="ts">
	import { base } from '$app/paths';
	import { diffBoards, type BoardChanges } from '$lib/domain/board-changes';
	import type { CaseInputRequest, GuidanceSnapshot } from '$lib/domain/guidance';
	import type { BackgroundBoard, EvidenceKind } from '$lib/domain/types';
	import { parseRedactionReplacements, redactText } from '$lib/privacy/redact';
	import AgentActivity from '$lib/components/AgentActivity.svelte';
	import CaseFeedback from '$lib/components/CaseFeedback.svelte';
	import ClaimStack from '$lib/components/ClaimStack.svelte';
	import ClueShelf from '$lib/components/ClueShelf.svelte';
	import CompleterCard from '$lib/components/CompleterCard.svelte';
	import EvidenceRail from '$lib/components/EvidenceRail.svelte';
	import GuidancePanel from '$lib/components/GuidancePanel.svelte';
	import NextActionCard from '$lib/components/NextActionCard.svelte';
	import ParticipantCard from '$lib/components/ParticipantCard.svelte';
	import RunStatus from '$lib/components/RunStatus.svelte';
	import StageBadge from '$lib/components/StageBadge.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	function initialGuidance() {
		return data.view.guidance ?? data.previousGuidance;
	}
	let updatedView = $state<PageData['view'] | null>(null);
	let view = $derived(updatedView ?? data.view);
	let shownGuidance = $state<GuidanceSnapshot | null>(initialGuidance());
	let historyDetails = $state<Record<string, GuidanceSnapshot>>({});
	let historyLoading = $state<string | null>(null);
	let historyFailure = $state('');
	let guidedStatus = $state('');
	let guidedFailure = $state('');
	let guidedLoading = $state(false);
	let guidedPhase = $state('');
	let guidedElapsedMs = $state(0);

	let proposedOverride = $state<BackgroundBoard | null | undefined>(undefined);
	let proposedBoard = $derived(
		proposedOverride === undefined ? (data.view.case.pendingBoard ?? null) : proposedOverride
	);
	let newEvidence = $state('');
	let newEvidenceKind = $state<EvidenceKind>('message');
	let sourceLabel = $state('我的补充');
	let replacementText = $state('');
	let evidenceConfirmedSignature = $state('');
	let evidenceOfficialSignature = $state('');
	let loading = $state(false);
	let failure = $state('');
	let failureTitle = $state('');
	let failureSuggestion = $state('');
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
	let evidencePreviewSignature = $derived(
		JSON.stringify({ newEvidence, newEvidenceKind, sourceLabel, replacementText })
	);
	let evidenceConfirmed = $derived(
		Boolean(evidencePreview) && evidenceConfirmedSignature === evidencePreviewSignature
	);
	let evidenceIsOfficial = $derived(
		Boolean(evidencePreview) && evidenceOfficialSignature === evidencePreviewSignature
	);
	let activeCaseId = $state('');
	function isCurrentCase(caseId: string) {
		return data.view.case.id === caseId;
	}

	$effect.pre(() => {
		const nextCaseId = data.view.case.id;
		if (nextCaseId === activeCaseId) return;
		activeCaseId = nextCaseId;
		updatedView = null;
		shownGuidance = data.view.guidance ?? data.previousGuidance;
		historyDetails = {};
		historyLoading = null;
		historyFailure = '';
		guidedStatus = '';
		guidedFailure = '';
		guidedLoading = false;
		guidedPhase = '';
		guidedElapsedMs = 0;
		proposedOverride = undefined;
		changesOverride = null;
		newEvidence = '';
		newEvidenceKind = 'message';
		sourceLabel = '我的补充';
		replacementText = '';
		evidenceConfirmedSignature = '';
		evidenceOfficialSignature = '';
		loading = false;
		failure = '';
		failureTitle = '';
		failureSuggestion = '';
	});

	const PHASE_LABELS: Record<string, string> = {
		thinking: '正在理解你的材料',
		searching: '正在检索相似经验',
		repairing: '正在重新整理',
		saving: '正在保存这一版'
	};

	function pollDelayMs() {
		return 1_500;
	}

	/**
	 * 启动一轮整理后轮询进度，等待期间把真实阶段和已耗时显示出来。
	 * 长推理不再表现为一个可能被中间环节掐断的阻塞请求。
	 */
	async function runGuidance(savedInput: '补充' | null = null, caseId = view.case.id) {
		guidedLoading = true;
		guidedFailure = '';
		guidedStatus = '';
		guidedPhase = '';
		guidedElapsedMs = 0;
		try {
			const startResponse = await fetch(`${base}/api/cases/${caseId}/guidance/runs`, {
				method: 'POST'
			});
			const startPayload = await startResponse.json();
			if (!isCurrentCase(caseId)) return;
			if (!startResponse.ok || !startPayload.ok)
				throw new Error(startPayload.error?.message ?? '本轮整理没有开始');

			const runId = startPayload.data.runId as string;
			let payload;
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, pollDelayMs()));
				if (!isCurrentCase(caseId)) return;
				const pollResponse = await fetch(`${base}/api/cases/${caseId}/guidance/runs/${runId}`);
				const pollPayload = await pollResponse.json();
				if (!isCurrentCase(caseId)) return;
				if (!pollResponse.ok || !pollPayload.ok)
					throw new Error(pollPayload.error?.message ?? '本轮整理没有完成');
				guidedPhase = String(pollPayload.data.phase ?? '');
				guidedElapsedMs = Number(pollPayload.data.elapsedMs ?? 0);
				if (pollPayload.data.done) {
					payload = { ok: true, data: { ...pollPayload.data.view, run: pollPayload.data.run } };
					break;
				}
			}
			updatedView = payload.data;
			if (payload.data.guidance) shownGuidance = payload.data.guidance;
			if (payload.data.run?.outcome === 'failed') {
				guidedFailure = savedInput ? `${savedInput}已保存，本轮未完成` : '本轮整理没有完成';
				guidedStatus = payload.data.run.error?.message ?? '可以稍后只重试整理';
			} else if (payload.data.run?.outcome === 'superseded') {
				guidedFailure = '已由更新后的整理替代';
				guidedStatus = '这版结果没有成为当前理解，请只重试整理。';
			} else {
				guidedStatus =
					payload.data.run?.outcome === 'needs_input'
						? '已整理到最新补充，还需要你回答一个问题。'
						: '已根据最新补充重新整理。';
			}
		} catch (error) {
			if (!isCurrentCase(caseId)) return;
			guidedFailure = savedInput ? `${savedInput}已保存，本轮未完成` : '本轮整理没有完成';
			guidedStatus = error instanceof Error ? error.message : '可以稍后只重试整理';
		} finally {
			if (isCurrentCase(caseId)) guidedLoading = false;
		}
	}

	async function saveFeedback(
		input: CaseInputRequest & { replacements: { from: string; to: string }[] }
	): Promise<boolean> {
		const caseId = view.case.id;
		guidedLoading = true;
		guidedFailure = '';
		guidedStatus = '';
		guidedPhase = '';
		guidedElapsedMs = 0;
		try {
			const response = await fetch(`${base}/api/cases/${caseId}/inputs`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(input)
			});
			const payload = await response.json();
			if (!isCurrentCase(caseId)) return false;
			if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? '补充没有保存');
			updatedView = payload.data;
			guidedStatus = '补充已保存，正在重新整理。';
			guidedLoading = false;
			void runGuidance('补充', caseId);
			return true;
		} catch (error) {
			if (!isCurrentCase(caseId)) return false;
			guidedFailure = error instanceof Error ? error.message : '补充没有保存';
			guidedLoading = false;
			return false;
		}
	}

	async function loadHistory(guidanceId: string) {
		if (historyDetails[guidanceId] || historyLoading === guidanceId) return;
		const caseId = view.case.id;
		historyLoading = guidanceId;
		historyFailure = '';
		try {
			const response = await fetch(`${base}/api/cases/${caseId}/guidance/${guidanceId}`);
			const payload = await response.json();
			if (!isCurrentCase(caseId)) return;
			if (!response.ok || !payload.ok)
				throw new Error(payload.error?.message ?? '这版记录暂时无法打开');
			historyDetails = { ...historyDetails, [guidanceId]: payload.data };
		} catch (error) {
			if (!isCurrentCase(caseId)) return;
			historyFailure = error instanceof Error ? error.message : '这版记录暂时无法打开';
		} finally {
			if (isCurrentCase(caseId)) historyLoading = null;
		}
	}

	async function addGuidedEvidence() {
		if (!newEvidence.trim() || !evidenceConfirmed) return;
		const caseId = view.case.id;
		guidedLoading = true;
		guidedFailure = '';
		guidedStatus = '';
		guidedPhase = '';
		guidedElapsedMs = 0;
		try {
			const response = await fetch(`${base}/api/cases/${caseId}/evidence`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					kind: newEvidenceKind,
					content: newEvidence,
					sourceLabel,
					replacements,
					occurredAt: null,
					confirmation: 'self_reported'
				})
			});
			const payload = await response.json();
			if (!isCurrentCase(caseId)) return;
			if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? '材料没有保存');
			updatedView = payload.data;
			newEvidence = '';
			replacementText = '';
			evidenceConfirmedSignature = '';
			evidenceOfficialSignature = '';
			if (payload.data.guidance) shownGuidance = payload.data.guidance;
			if (payload.data.run?.outcome === 'failed') {
				guidedFailure = '材料已保存，本轮未完成';
				guidedStatus = payload.data.run.error?.message ?? '可以稍后只重试整理';
			} else if (payload.data.run?.outcome === 'superseded') {
				guidedFailure = '材料已保存，本轮整理已由更新后的整理替代';
				guidedStatus = '这版结果没有成为当前理解，请只重试整理。';
			} else guidedStatus = '材料已保存，并已更新当前理解。';
		} catch (error) {
			if (!isCurrentCase(caseId)) return;
			guidedFailure = error instanceof Error ? error.message : '材料没有保存';
		} finally {
			if (isCurrentCase(caseId)) guidedLoading = false;
		}
	}

	async function refreshFrom(endpoint: string, body?: unknown): Promise<boolean> {
		const caseId = view.case.id;
		loading = true;
		failure = '';
		failureTitle = '';
		failureSuggestion = '';
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined
			});
			const payload = await response.json();
			if (!isCurrentCase(caseId)) return false;
			if (!response.ok || !payload.ok) {
				failureTitle = payload.error?.title ?? '';
				failureSuggestion = payload.error?.suggestion ?? '';
				throw new Error(payload.error?.message ?? '本轮判断没有完成');
			}
			const nextProposal =
				payload.data.run?.proposedBoard ?? payload.data.case.pendingBoard ?? null;
			changesOverride = diffBoards(view.case.board, nextProposal ?? payload.data.case.board);
			updatedView = payload.data;
			proposedOverride = nextProposal;
			newEvidence = '';
			if (payload.data.run?.outcome === 'failed') {
				failure = payload.data.run.summary;
				failureTitle = payload.data.run.error?.title ?? '';
				failureSuggestion = payload.data.run.error?.suggestion ?? '';
			}
			if (payload.data.run?.outcome === 'partial') {
				failure = payload.data.run.summary;
				failureTitle = '本轮未完全整理';
			}
			if (!nextProposal) clearChangesLater(caseId);
			return true;
		} catch (error) {
			if (!isCurrentCase(caseId)) return false;
			failure = error instanceof Error ? error.message : '本轮判断没有完成';
			return false;
		} finally {
			if (isCurrentCase(caseId)) loading = false;
		}
	}

	function clearChangesLater(caseId = view.case.id) {
		setTimeout(() => {
			if (isCurrentCase(caseId)) {
				changesOverride = { blocker: false, claimIds: [], nextAction: false };
			}
		}, 5000);
	}

	async function reviewProposal(action: 'confirm' | 'discard') {
		if (!proposedBoard) return;
		const caseId = view.case.id;
		loading = true;
		failure = '';
		try {
			const response = await fetch(`${base}/api/cases/${caseId}/proposal`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, expectedRevision: view.case.revision })
			});
			const payload = await response.json();
			if (!isCurrentCase(caseId)) return;
			if (!response.ok || !payload.ok)
				throw new Error(payload.error?.message ?? '没有完成这次审阅');
			updatedView = payload.data;
			proposedOverride = null;
			if (action === 'discard')
				changesOverride = { blocker: false, claimIds: [], nextAction: false };
			else clearChangesLater(caseId);
		} catch (error) {
			if (!isCurrentCase(caseId)) return;
			failure = error instanceof Error ? error.message : '没有完成这次审阅';
		} finally {
			if (isCurrentCase(caseId)) loading = false;
		}
	}

	async function addEvidence() {
		if (!newEvidence.trim() || !evidenceConfirmed) return;
		const caseId = view.case.id;
		const saved = await refreshFrom(`${base}/api/cases/${caseId}/evidence`, {
			kind: newEvidenceKind,
			content: newEvidence,
			sourceLabel,
			replacements,
			occurredAt: null,
			confirmation: evidenceIsOfficial ? 'official' : 'self_reported'
		});
		if (!saved || !isCurrentCase(caseId)) return;
		replacementText = '';
		evidenceConfirmedSignature = '';
		evidenceOfficialSignature = '';
	}

	async function confirmEvidenceItem(evidenceId: string) {
		const caseId = view.case.id;
		loading = true;
		failure = '';
		try {
			const response = await fetch(`${base}/api/cases/${caseId}/evidence/${evidenceId}/confirm`, {
				method: 'POST'
			});
			const payload = await response.json();
			if (!isCurrentCase(caseId)) return;
			if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? '确认没有成功');
			updatedView = payload.data;
		} catch (error) {
			if (!isCurrentCase(caseId)) return;
			failure = error instanceof Error ? error.message : '确认没有成功';
		} finally {
			if (isCurrentCase(caseId)) loading = false;
		}
	}

	function formatTime(value: string) {
		return new Intl.DateTimeFormat('zh-CN', {
			month: 'numeric',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date(value));
	}
</script>

<svelte:head
	><title>{view.case.title} · {view.mode === 'guided' ? '工作理解' : '背景板'}</title></svelte:head
>

{#if view.mode === 'guided'}
	<main class="guided-main">
		<header class="guided-case-head">
			<p class="guided-meta">案例目标</p>
			<h1>{view.case.title}</h1>
			<p class="guided-goal">{view.case.goal}</p>
		</header>

		{#if guidedLoading || guidedFailure || guidedStatus}
			<RunStatus
				busy={guidedLoading}
				failed={Boolean(guidedFailure)}
				title={guidedLoading
					? (PHASE_LABELS[guidedPhase] ?? '正在处理你的材料')
					: guidedFailure || '本轮整理已完成'}
				detail={guidedLoading ? '可以继续查看已有内容，请等待本轮结果。' : guidedStatus}
				elapsedMs={guidedElapsedMs}
				onRetry={() => runGuidance()}
			/>
		{/if}

		{#if shownGuidance}
			<GuidancePanel
				snapshot={shownGuidance}
				evidence={view.case.evidence}
				inputs={view.inputs}
				instanceId={`current-${view.case.id}`}
				stale={shownGuidance.contextRevision < view.contextRevision}
			/>
		{:else}
			<section class="guided-empty">
				<h2>先形成一版暂时理解</h2>
				<p>我会根据现有材料梳理哪些环节还值得核对，并找一个可以尝试的下一步。</p>
				<button class="button" type="button" disabled={guidedLoading} onclick={() => runGuidance()}>
					{guidedLoading ? '正在整理…' : '开始整理'}
				</button>
			</section>
		{/if}

		{#key view.case.id}
			<CaseFeedback
				guidanceId={shownGuidance?.id ?? null}
				question={shownGuidance?.draft.question ?? null}
				loading={guidedLoading}
				onSave={saveFeedback}
			/>
		{/key}

		<section class="guidance-record">
			<div class="record-head">
				<h2>整理记录</h2>
				{#if shownGuidance}<time datetime={shownGuidance.createdAt}
						>{formatTime(shownGuidance.createdAt)}</time
					>{/if}
			</div>
			{#if shownGuidance?.draft.changeSummary}<p class="change-summary">
					{shownGuidance.draft.changeSummary}
				</p>{/if}
			{#if view.guidanceHistory.length}
				<details class="history-list">
					<summary>查看最近 {view.guidanceHistory.length} 次理解</summary>
					<div>
						{#each [...view.guidanceHistory].reverse() as item (item.id)}
							<details
								class="history-item"
								ontoggle={(event) => {
									if (event.currentTarget.open) void loadHistory(item.id);
								}}
							>
								<summary
									><span>{item.changeSummary ?? item.understandingSummary}</span><time
										datetime={item.createdAt}>{formatTime(item.createdAt)}</time
									></summary
								>
								{#if historyLoading === item.id}<p class="fine-print">正在打开这版记录…</p>{/if}
								{#if historyDetails[item.id]}<GuidancePanel
										snapshot={historyDetails[item.id]}
										evidence={view.case.evidence}
										inputs={view.inputs}
										instanceId={`history-${item.id}`}
										compact
									/>{/if}
							</details>
						{/each}
						{#if historyFailure}<p class="error-box">{historyFailure}</p>{/if}
					</div>
				</details>
			{/if}
			{#if view.inputs.length}
				<details class="input-history">
					<summary>查看你的补充与回答（{view.inputs.length}）</summary>
					<ul>
						{#each [...view.inputs].reverse() as input (input.id)}<li>
								<time datetime={input.createdAt}>{formatTime(input.createdAt)}</time>
								<p>{input.content}</p>
							</li>{/each}
					</ul>
				</details>
			{/if}
		</section>

		<details class="guided-materials">
			<summary>原材料与补充</summary>
			<div class="material-body">
				{#if view.case.evidence.length}
					<ul class="material-list">
						{#each view.case.evidence as item (item.id)}<li>
								<strong>{item.sourceLabel}</strong>
								<p>{item.content}</p>
							</li>{/each}
					</ul>
				{:else}<p class="muted">还没有添加原材料。</p>{/if}
				<div class="guided-evidence-form">
					<h2>追加一段原材料</h2>
					<div class="composer-row">
						<label>材料来自哪里<input bind:value={sourceLabel} maxlength="120" /></label>
						<label
							>材料类型<select bind:value={newEvidenceKind}
								><option value="message">聊天 / 回复</option><option value="email">邮件</option
								><option value="notice">通知</option><option value="call">通话记录</option><option
									value="note">个人笔记</option
								></select
							></label
						>
					</div>
					<textarea
						bind:value={newEvidence}
						maxlength="30000"
						aria-label="原材料内容"
						placeholder="粘贴聊天、邮件、通知或通话记录。"></textarea>
					<textarea
						class="replacement-input"
						bind:value={replacementText}
						maxlength="2000"
						aria-label="原材料中的敏感词替换"
						placeholder="可选：每行填写 原词 => 替换词"></textarea>
					{#if evidencePreview}
						<div class="preview-box compact-preview">
							<strong>外发预览</strong>\n\n{evidencePreview}
						</div>
						<label class="confirmation-line"
							><input
								type="checkbox"
								checked={evidenceConfirmed}
								onchange={(event) => {
									evidenceConfirmedSignature = event.currentTarget.checked
										? evidencePreviewSignature
										: '';
								}}
							/>我已检查预览，确认可以用于重新整理</label
						>
					{/if}
					<button
						class="button secondary"
						type="button"
						onclick={addGuidedEvidence}
						disabled={guidedLoading || !newEvidence.trim() || !evidenceConfirmed}
						>{guidedLoading ? '正在保存…' : '保存材料并重新整理'}</button
					>
				</div>
			</div>
		</details>

		{#if view.case.board || view.case.pendingBoard}
			<details class="legacy-board-history">
				<summary>查看旧背景板（历史）</summary>
				{#if board}<section class="blocker-banner">
						<span>当时的卡点</span>
						<h2>{board.currentBlocker}</h2>
					</section>{/if}
				{#if board}<div class="board-grid">
						<aside class="evidence-column"><EvidenceRail evidence={view.case.evidence} /></aside>
						<section class="understanding-column">
							<ClaimStack claims={board.claims} evidence={view.case.evidence} changedIds={[]} />
						</section>
						<aside class="action-column">
							{#if board.nextAction}<NextActionCard action={board.nextAction} />{/if}
						</aside>
					</div>{/if}
			</details>
		{/if}
	</main>
{:else}
	<main>
		{#if loading}<RunStatus
				busy
				title="正在处理案例"
				detail="正在保存材料或更新背景板，请稍候。"
			/>{/if}
		<header class="case-head">
			<div class="case-meta">
				<StageBadge stage={board?.stage ?? view.case.stage} /><span
					>第 {view.case.revision} 次整理</span
				>
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
					<p class="fine-print">
						负责方明确回复过的信息，点“负责方已明确回复过”升级为已确认，才能支撑“已确认事实”。
					</p>
					<EvidenceRail evidence={view.case.evidence} onConfirm={confirmEvidenceItem} />
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
							changed={changes.keyCompleter}
						/>{/if}{#if board.nextAction}<NextActionCard
							action={board.nextAction}
							changed={changes.nextAction}
						/>{/if}<AgentActivity events={view.events} />
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
					><button
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
				<label
					>消息来源<input aria-label="消息来源" bind:value={sourceLabel} maxlength="120" /></label
				><label
					>材料类型<select aria-label="材料类型" bind:value={newEvidenceKind}
						><option value="message">聊天 / 回复</option><option value="email">邮件</option><option
							value="notice">正式通知</option
						><option value="call">通话记录</option><option value="note">个人笔记</option></select
					></label
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
			{#if evidencePreview}<div class="preview-box compact-preview">
					<strong>本次外发预览</strong>\n\n{evidencePreview}
				</div>
				<label class="fine-print confirmation-line"
					><input
						type="checkbox"
						checked={evidenceConfirmed}
						onchange={(event) => {
							evidenceConfirmedSignature = event.currentTarget.checked
								? evidencePreviewSignature
								: '';
						}}
					/> 我已检查这条新证据的脱敏预览</label
				><label class="fine-print confirmation-line"
					><input
						type="checkbox"
						checked={evidenceIsOfficial}
						onchange={(event) => {
							evidenceOfficialSignature = event.currentTarget.checked
								? evidencePreviewSignature
								: '';
						}}
					/> 负责方已经明确回复过这个结果（可被当作已确认事实）</label
				>{/if}
			<button
				class="button"
				type="button"
				onclick={addEvidence}
				disabled={loading || !newEvidence.trim() || !evidenceConfirmed}
				>{loading ? '正在重新判断…' : '加入证据并继续判断'}</button
			>
			{#if failure}<div class="error-box" role="alert">
					{#if failureTitle}<strong>{failureTitle}</strong>{/if}
					<p>{failure}</p>
					{#if failureSuggestion}<p class="fine-print">{failureSuggestion}</p>{/if}
				</div>{/if}
			{#if changes.blocker || changes.claimIds.length || changes.removedClaimCount || changes.nextAction || changes.stage || changes.keyCompleter || changes.participants || changes.externalClues}<p
					class="update-note"
					aria-live="polite"
				>
					本次更新：{changes.stage ? '事项阶段已变化；' : ''}{changes.blocker
						? '阻塞点已变化；'
						: ''}{changes.claimIds.length
						? `${changes.claimIds.length} 条判断已变化；`
						: ''}{changes.removedClaimCount
						? `${changes.removedClaimCount} 条旧判断已移除；`
						: ''}{changes.keyCompleter ? '关键补全者已变化；' : ''}{changes.participants
						? '参与者信息已变化；'
						: ''}{changes.externalClues ? '外部线索已变化；' : ''}{changes.nextAction
						? '下一步行动已变化。'
						: ''}
				</p>{/if}
		</section>
	</main>
{/if}
