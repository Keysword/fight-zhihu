<script lang="ts">
	import type { KeyCompleter, Participant } from '$lib/domain/types';
	let { completer, participants }: { completer: KeyCompleter; participants: Participant[] } =
		$props();
	let person = $derived(participants.find((item) => item.id === completer.participantId));
	const confidence = { low: '低置信', medium: '中置信', high: '高置信' };
</script>

<section class="completer-card">
	<span class="confidence">{confidence[completer.confidence]}</span>
	<span class="kicker">最可能补全信息的人</span>
	<h3>{person?.name ?? '待确认'}</h3>
	<p>{completer.rationale}</p>
	<p><strong>能补全：</strong>{completer.scope}</p>
	<p class="uncertainty"><strong>仍需保留：</strong>{completer.uncertainty}</p>
</section>
