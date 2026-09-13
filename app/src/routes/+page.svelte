<script lang="ts">
	import { base, resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	let guided = $derived(data.mode === 'guided');
	let loading = $state(false);
	let failure = $state('');
	async function openDemo() {
		loading = true;
		failure = '';
		try {
			const response = await fetch(`${base}/api/demo`, { method: 'POST' });
			const payload = await response.json();
			if (!response.ok || !payload.ok)
				throw new Error(payload.error?.message ?? '演示案例载入失败');
			await goto(resolve('/cases/[id]', { id: payload.data.case.id }));
		} catch (error) {
			failure = error instanceof Error ? error.message : '演示案例载入失败';
		} finally {
			loading = false;
		}
	}
</script>

<main>
	<section class="hero">
		<div class="hero-copy">
			<p class="kicker">给刚进入职场、正在摸索规则的你</p>
			{#if guided}
				<h1 aria-label="先形成一版理解，再试一个下一步">先形成一版理解，<br />再试一个下一步</h1>
				<p>
					把聊天、通知和你的困惑放上来。我们会先写下一版可以被纠正的理解，留意沟通里可能需要核对的环节，再帮你组织一个能继续推进的动作。
				</p>
			{:else}
				<h1 aria-label="先把背景拼完整，再决定下一步">先把背景拼完整，<br />再决定下一步</h1>
				<p>
					把聊天、通知和你的困惑放上来。背景板会分清事实、说法、推断与未知，找到最可能补全信息的人，并替你组织一段说得清楚的求助。
				</p>
			{/if}
			<div class="hero-actions">
				<button class="button" type="button" onclick={openDemo} disabled={loading}
					>{loading ? '正在铺开案例…' : '体验宿舍案例'}</button
				>
				<a class="button secondary" href={resolve('/cases/new')}>新建一件卡住的事</a>
			</div>
			<p class="demo-status" role="status">{failure}</p>
		</div>
		<aside class="dossier-preview" aria-label={guided ? '工作理解案例预览' : '背景板案例预览'}>
			<p class="kicker">新人入住宿舍</p>
			<h2>安排了接引，为什么还是不能确定能否入住？</h2>
			<div class="preview-rule"></div>
			<div class="preview-line">
				<span>{guided ? '暂时理解' : '已知'}</span><strong>同事可以带你进入园区</strong>
			</div>
			<div class="preview-line blocker">
				<span>真正卡点</span><strong>房间和钥匙仍没人确认</strong>
			</div>
			<div class="preview-line"><span>找谁</span><strong>人力 / 住宿管理方</strong></div>
			<div class="preview-action">
				<span>下一句话</span>“我已经了解到接引安排，但还没有房间与钥匙信息，想请您协助确认……”
			</div>
		</aside>
	</section>
	<section class="principles" id="how-it-works">
		<p class="kicker">
			{guided ? '建议始终可以补充，也可以纠正' : '不是表格流程，而是一位会继续追问的 Agent'}
		</p>
		<h2>
			{guided
				? '先把复杂的事缩成一版工作理解，再从现实里试一步。'
				: '它围绕你的目标自由判断，但每一项写入都要过证据关。'}
		</h2>
		<div class="principle-grid">
			<article class="principle">
				<span class="symbol">≠</span>
				<h3>{guided ? '形成暂时理解' : '拆开口径'}</h3>
				<p>
					{guided
						? '把散落的聊天、通知和你的经历放在一起，先写出一版可继续修正的理解。'
						: '“可以申请”“已经安排”“能够入住”不是一件事。背景板会把混在一起的说法逐项拆开。'}
				</p>
			</article>
			<article class="principle">
				<span class="symbol">◎</span>
				<h3>{guided ? '核对沟通断点' : '定位补全者'}</h3>
				<p>
					{guided
						? '只在材料有迹可循时，提醒哪些说法可能回答了不同问题，并给出核对办法。'
						: '不猜谁在隐瞒，只判断谁有正式职责、信息入口或协调能力，最可能拿到缺失信息。'}
				</p>
			</article>
			<article class="principle">
				<span class="symbol">↳</span>
				<h3>{guided ? '试一个下一步' : '组织下一问'}</h3>
				<p>
					{guided
						? '从一个问题、一段消息或一次核对开始，用行动结果继续修正这版理解。'
						: '复述你已经知道的背景，点明仍然困惑的地方，再向对的人提出一个能推进事情的问题。'}
				</p>
			</article>
		</div>
	</section>
</main>
