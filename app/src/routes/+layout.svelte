<script lang="ts">
	import { base, resolve } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';

	let { data, children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="manifest" href={`${base}/manifest.webmanifest`} />
	<link rel="apple-touch-icon" href={`${base}/icon-192.png`} />
	<title>背景板</title>
</svelte:head>

<header class="site-header">
	<a class="brand" href={resolve('/')} aria-label="背景板首页">
		<span class="brand-mark" aria-hidden="true">背</span>
		<span>背景板</span>
	</a>
	<nav aria-label="主要导航">
		<a href={resolve('/cases/new')}>新建案例</a>
		<a href={resolve('/#how-it-works')}>{data.mode === 'guided' ? '它怎么帮你' : '它怎么判断'}</a>
	</nav>
</header>

{@render children()}

<footer class="site-footer">
	{#if data.mode === 'guided'}
		<p>先形成一版可以纠正的理解，再从现实里试一步。</p>
		<p>外部经验只作启发；沟通疑点只在你的材料有迹可循时出现。</p>
	{:else}
		<p>先把背景说清楚，再向真正能补全信息的人求助。</p>
		<p>外部经验只作线索，所有结论都回到你的证据。</p>
	{/if}
</footer>
