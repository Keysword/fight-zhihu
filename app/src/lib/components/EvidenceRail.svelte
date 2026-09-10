<script lang="ts">
	import type { Evidence } from '$lib/domain/types';
	let { evidence, onConfirm }: { evidence: Evidence[]; onConfirm?: (evidenceId: string) => void } =
		$props();
	const kindLabels: Record<Evidence['kind'], string> = {
		message: '消息',
		email: '邮件',
		notice: '通知',
		call: '通话',
		note: '补充'
	};
	/** 正式通知天然算已确认，不需要用户再操作。 */
	function isConfirmed(item: Evidence): boolean {
		return item.kind === 'notice' || item.confirmation === 'official';
	}
</script>

<ul class="evidence-list">
	{#each evidence as item (item.id)}
		<li class="evidence-item">
			<div class="evidence-source">
				<span>{item.sourceLabel}</span>
				<span class="evidence-tags">
					<span>{kindLabels[item.kind]}</span>
					{#if isConfirmed(item)}<span class="evidence-confirmed">已确认</span>{/if}
				</span>
			</div>
			<p>{item.content}</p>
			{#if !isConfirmed(item) && onConfirm}
				<button
					class="evidence-confirm-action"
					type="button"
					onclick={() => onConfirm(item.id)}
					title="负责方已经明确回复过这条信息时，可升级为支撑“已确认事实”的证据"
					>负责方已明确回复过</button
				>
			{/if}
		</li>
	{/each}
</ul>
