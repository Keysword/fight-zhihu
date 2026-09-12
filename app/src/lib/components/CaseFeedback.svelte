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

	const kinds: Array<{ value: InputKind; label: string }> = [
		{ value: 'context', label: '补充情况' },
		{ value: 'correction', label: '纠正理解' },
		{ value: 'constraint', label: '说明限制' },
		{ value: 'action_result', label: '反馈结果' },
		{ value: 'question', label: '提出问题' }
	];
	let kind = $state<InputKind>('context');
	let content = $state('');
	let replacementText = $state('');
	let confirmed = $state(false);
	let field: HTMLTextAreaElement;
	let replacements = $derived(parseRedactionReplacements(replacementText).slice(0, 30));
	let preview = $derived(content ? redactText(content, replacements).redacted : '');

	function chooseKind(next: InputKind) {
		kind = next;
		field?.focus();
	}

	async function submit() {
		if (!content.trim() || !confirmed || loading) return;
		const answeringQuestion = Boolean(question) && kind === 'context';
		const saved = await onSave({
			kind: answeringQuestion ? 'context' : kind,
			content,
			guidanceId: answeringQuestion ? guidanceId : guidanceId,
			requestId: crypto.randomUUID(),
			replacements
		});
		if (!saved) return;
		content = '';
		replacementText = '';
		confirmed = false;
		kind = 'context';
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
	<div class="feedback-kinds" aria-label="补充类型">
		{#each kinds as item (item.value)}
			<button
				type="button"
				class:active={kind === item.value}
				onclick={() => chooseKind(item.value)}>{item.label}</button
			>
		{/each}
	</div>
	<textarea
		bind:this={field}
		bind:value={content}
		maxlength="5000"
		placeholder={question && kind === 'context'
			? '直接回答上面的问题，也可以补充你刚了解到的情况。'
			: '写下新情况、需要纠正的地方，或行动后的结果。'}
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
			<input type="checkbox" bind:checked={confirmed} />
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
