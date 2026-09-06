<script lang="ts">
	import { base, resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { parseRedactionReplacements, redactText } from '$lib/privacy/redact';
	let title = $state('');
	let goal = $state('');
	let confusion = $state('');
	let evidence = $state('');
	let sourceLabel = $state('同事 / 通知');
	let replacementText = $state('');
	let confirmed = $state(false);
	let loading = $state(false);
	let failure = $state('');
	const replacementPlaceholder = '每行一项，例如：\n甲公司 => [单位]\n张老师 => 人力老师';
	let replacements = $derived(parseRedactionReplacements(replacementText).slice(0, 30));
	let preview = $derived(
		[
			`标题：${redactText(title, replacements).redacted}`,
			`目标：${redactText(goal, replacements).redacted}`,
			`困惑：${redactText(confusion, replacements).redacted}`,
			...(evidence
				? [
						`来源：${redactText(sourceLabel, replacements).redacted}`,
						`证据：${redactText(evidence, replacements).redacted}`
					]
				: [])
		]
			.filter((line) => !line.endsWith('：'))
			.join('\n\n')
	);
	async function createCase() {
		if (!confirmed) return;
		loading = true;
		failure = '';
		let caseId = '';
		try {
			const response = await fetch(`${base}/api/cases`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title,
					goal,
					confusion,
					replacements,
					evidence: evidence.trim()
						? [{ kind: 'message', content: evidence, sourceLabel, occurredAt: null }]
						: []
				})
			});
			const payload = await response.json();
			if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? '案例创建失败');
			caseId = payload.data.case.id;
			await fetch(`${base}/api/cases/${caseId}/run`, { method: 'POST' });
			await goto(resolve('/cases/[id]', { id: caseId }));
		} catch (error) {
			failure = error instanceof Error ? error.message : '案例创建失败';
			if (caseId) await goto(resolve('/cases/[id]', { id: caseId }));
		} finally {
			loading = false;
		}
	}
</script>

<main>
	<header class="page-head">
		<p class="kicker">新建案例</p>
		<h1>把卡住的事讲给背景板</h1>
		<p class="goal-line">
			不必先整理得很漂亮。说明你想做到什么、哪里想不通，再贴上一两段原始信息。
		</p>
	</header>
	<form
		class="form-sheet"
		onsubmit={(event) => {
			event.preventDefault();
			createCase();
		}}
	>
		<div class="field">
			<label for="title">给这件事起个短标题</label><input
				id="title"
				bind:value={title}
				required
				maxlength="120"
				placeholder="例如：入职第一天怎么领电脑"
			/>
		</div>
		<div class="field">
			<label for="goal">你最终想做到什么？</label><textarea
				id="goal"
				bind:value={goal}
				required
				maxlength="500"
				placeholder="例如：确认周一到公司后能领到电脑并开始工作"></textarea>
		</div>
		<div class="field">
			<label for="confusion">现在最让你困惑的地方</label><textarea
				id="confusion"
				bind:value={confusion}
				required
				maxlength="2000"
				placeholder="谁说过什么？哪些信息互相对不上？你已经问过谁？"></textarea>
		</div>
		<div class="field">
			<label for="source">这段信息来自谁</label><input
				id="source"
				bind:value={sourceLabel}
				required
				maxlength="120"
			/>
		</div>
		<div class="field">
			<label for="evidence">先放一条证据（可选）</label><textarea
				id="evidence"
				bind:value={evidence}
				maxlength="30000"
				placeholder="粘贴聊天、邮件或通知正文。手机号、邮箱和身份证号会自动替换。"></textarea>
		</div>
		<div class="field">
			<label for="replacements">还有哪些姓名、单位或内部项目需要替换？（可选）</label><textarea
				id="replacements"
				bind:value={replacementText}
				maxlength="2000"
				placeholder={replacementPlaceholder}></textarea>
			<small>自动规则无法可靠识别人名和公司名。这里的替换会同时用于预览和服务端存储。</small>
		</div>
		{#if preview}<div>
				<strong>发送前预览</strong>
				<div class="preview-box">{preview}</div>
			</div>{/if}
		<label class="fine-print"
			><input type="checkbox" bind:checked={confirmed} /> 我已检查预览，确认可以把这些内容交给后台 Agent
			分析。</label
		>
		{#if failure}<div class="error-box" role="alert">{failure}</div>{/if}
		<div style="margin-top:24px">
			<button class="button" type="submit" disabled={!confirmed || loading}
				>{loading ? '正在建立背景板…' : '建立背景板并开始判断'}</button
			>
		</div>
	</form>
</main>
