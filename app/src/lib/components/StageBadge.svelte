<script lang="ts">
	import type { CaseStage } from '$lib/domain/types';
	let { stage }: { stage: CaseStage } = $props();
	const labels: Record<CaseStage, string> = {
		collecting: '收集背景',
		understanding: '梳理关系',
		waiting: '等待补充',
		actionable: '可以行动',
		resolved: '已经解决'
	};
</script>

<span class={`stage-badge stage-${stage}`}>{labels[stage]}</span>
