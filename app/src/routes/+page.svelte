<script lang="ts">
	import { base, resolve } from '$app/paths';
	import { goto } from '$app/navigation';
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
			<h1 aria-label="先形成一版理解，再试一个下一步">先形成一版理解，<br />再试一个下一步</h1>
			<p>
				把聊天、通知和你的困惑放上来。我们会先写下一版可以被纠正的理解，留意沟通里可能失真的环节，再帮你组织一个能继续推进的动作。
			</p>
			<div class="hero-actions">
				<button class="button" type="button" onclick={openDemo} disabled={loading}
					>{loading ? '正在铺开案例…' : '体验宿舍案例'}</button
				>
				<a class="button secondary" href={resolve('/cases/new')}>新建一件卡住的事</a>
			</div>
			<p class="demo-status" role="status">{failure}</p>
		</div>
		<aside class="dossier-preview" aria-label="工作理解案例预览">
			<p class="kicker">新人入住宿舍</p>
			<h2>安排了接引，为什么还是不能确定能否入住？</h2>
			<div class="preview-rule"></div>
			<div class="preview-line"><span>暂时理解</span><strong>同事可以带你进入园区</strong></div>
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
		<p class="kicker">建议始终可以补充，也可以纠正</p>
		<h2>先把复杂的事缩成一版工作理解，再从现实里试一步。</h2>
		<div class="principle-grid">
			<article class="principle">
				<span class="symbol">≠</span>
				<h3>形成暂时理解</h3>
				<p>把散落的聊天、通知和你的经历放在一起，先写出一版可继续修正的理解。</p>
			</article>
			<article class="principle">
				<span class="symbol">◎</span>
				<h3>发现沟通失真</h3>
				<p>留意“可以申请”“已经安排”“能够入住”这类容易被混在一起的说法。</p>
			</article>
			<article class="principle">
				<span class="symbol">↳</span>
				<h3>试一个下一步</h3>
				<p>从一个问题、一段消息或一次核对开始，用行动结果继续修正这版理解。</p>
			</article>
		</div>
	</section>
</main>
