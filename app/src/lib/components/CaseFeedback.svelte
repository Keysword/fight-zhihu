<script lang="ts">
	import type { CaseInputRequest } from '$lib/domain/guidance';
	import { parseRedactionReplacements, redactText } from '$lib/privacy/redact';

	type InputKind = CaseInputRequest['kind'];

	let {
		guidanceId,
		question = null,
		loading = false,
		onSave
	}: {
		guidanceId: string | null;
		question?: string | null;
		loading?: boolean;
		onSave: (
			input: CaseInputRequest & { replacements: { from: string; to: string }[] }
		) => Promise<boolean>;
	} = $props();

	const shortcuts: Array<{ id: string; kind: InputKind; label: string; placeholder: string }> = [
		{
			id: 'correction',
			kind: 'correction',
			label: '理解有误',
			placeholder: '指出哪里理解错了，以及你知道的实际情况。'
		},
		{
			id: 'unreachable',
			kind: 'constraint',
			label: '联系不上',
			placeholder: '谁联系不上？你现在还能通过哪些入口继续？'
		},
		{
			id: 'already-asked',
			kind: 'action_result',
			label: '我问过了',
			placeholder: '你问了谁、怎么问的，对方怎样回复或哪里没有回复？'
		},
		{
			id: 'new-reply',
			kind: 'context',
			label: '有新回复',
			placeholder: '写下新回复或刚了解到的情况。'
		}
	];
	let kind = $state<InputKind>('context');
	let selectedShortcut = $state<string | null>(null);
	let content = $state('');
	let replacementText = $state('');
	let confirmedSignature = $state('');
	let pendingRequestId = $state<string | null>(null);
	let pendingRequestSignature = $state('');
	let field: HTMLTextAreaElement;
	let replacements = $derived(parseRedactionReplacements(replacementText).slice(0, 30));
	let preview = $derived(content ? redactText(content, replacements).redacted : '');
	let previewSignature = $derived(
		JSON.stringify({ content, replacementText, kind, guidanceId, question })
	);
	let confirmed = $derived(Boolean(preview) && confirmedSignature === previewSignature);
	let placeholder = $derived(
		shortcuts.find((item) => item.id === selectedShortcut)?.placeholder ??
			(question
				? '直接回答上面的问题，也可以补充你刚了解到的情况。'
				: '写下新情况、需要纠正的地方、你的问题，或行动后的结果。')
	);

	function chooseShortcut(shortcut: (typeof shortcuts)[number]) {
		kind = shortcut.kind;
		selectedShortcut = shortcut.id;
		field?.focus();
	}

	async function submit() {
		if (!content.trim() || !confirmed || loading) return;
		const answeringQuestion = Boolean(question) && kind === 'context';
		const submittedKind = answeringQuestion ? 'context' : kind;
		const requestSignature = JSON.stringify({
			kind: submittedKind,
			content,
			guidanceId,
			replacements
		});
		if (!pendingRequestId || pendingRequestSignature !== requestSignature) {
			pendingRequestId = crypto.randomUUID();
			pendingRequestSignature = requestSignature;
		}
		const saved = await onSave({
			kind: submittedKind,
			content,
			guidanceId,
			requestId: pendingRequestId,
			replacements
		});
		if (!saved) return;
		pendingRequestId = null;
		pendingRequestSignature = '';
		content = '';
		replacementText = '';
		confirmedSignature = '';
		kind = 'context';
		selectedShortcut = null;
	}
</script>

<section class="case-feedback" aria-labelledby="feedback-heading">
	<h2 id="feedback-heading">补充情况，或告诉我这一步哪里不合适</h2>
	{#if question}
		<div class="feedback-question">
			<span>这版理解还在等你的回答</span>
			<p>{question}</p>
		</div>
	{/if}
	<div class="feedback-kinds" aria-label="常见情况">
		{#each shortcuts as item (item.id)}
			<button
				type="button"
				class:active={selectedShortcut === item.id}
				aria-pressed={selectedShortcut === item.id}
				onclick={() => chooseShortcut(item)}>{item.label}</button
			>
		{/each}
	</div>
	<textarea
		bind:this={field}
		bind:value={content}
		maxlength="5000"
		{placeholder}
		aria-label="补充情况"></textarea>
	<details class="redaction-options">
		<summary>替换姓名、单位或内部项目（可选）</summary>
		<textarea
			bind:value={replacementText}
			maxlength="2000"
			aria-label="敏感词替换"
			placeholder="每行填写 原词 => 替换词"></textarea>
	</details>
	{#if preview}
		<div class="feedback-preview">
			<strong>外发预览</strong>
			<p>{preview}</p>
		</div>
		<label class="confirmation-line">
			<input
				type="checkbox"
				checked={confirmed}
				onchange={(event) => {
					confirmedSignature = event.currentTarget.checked ? previewSignature : '';
				}}
			/>
			我已检查预览，确认可以用于重新整理
		</label>
	{/if}
	<button
		class="button"
		type="button"
		onclick={submit}
		disabled={loading || !content.trim() || !confirmed}
	>
		{loading
			? '正在保存…'
			: question && kind === 'context'
				? '保存回答并重新整理'
				: '保存补充并重新整理'}
	</button>
</section>
