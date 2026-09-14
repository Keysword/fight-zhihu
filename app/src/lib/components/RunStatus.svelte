<script lang="ts">
	let {
		busy = false,
		title,
		detail = '',
		failed = false,
		elapsedMs = 0,
		onRetry
	}: {
		busy?: boolean;
		title: string;
		detail?: string;
		failed?: boolean;
		elapsedMs?: number;
		onRetry?: () => void;
	} = $props();
</script>

<section class="run-status" class:busy class:failed aria-label="运行状态">
	<span class="run-status-icon" aria-hidden="true">{busy ? '' : failed ? '!' : '✓'}</span>
	<div class="run-status-copy" role="status" aria-live="polite" aria-atomic="true">
		<strong>{title}</strong>
		{#if detail}<p>{detail}</p>{/if}
		{#if busy && elapsedMs >= 20_000}
			<p>这轮整理用时较长，请稍候，无需重复提交。</p>
		{/if}
	</div>
	{#if busy}
		<span class="run-status-time">
			{elapsedMs > 0 ? `已用 ${Math.round(elapsedMs / 1000)} 秒` : '进行中'}
		</span>
	{:else if failed && onRetry}
		<button class="button secondary" type="button" onclick={onRetry}>只重试整理</button>
	{/if}
</section>
