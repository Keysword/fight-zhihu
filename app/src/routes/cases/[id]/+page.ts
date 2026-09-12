import { base } from '$app/paths';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { CaseView } from '$lib/server/services/case-service';
import type { GuidanceSnapshot } from '$lib/domain/guidance';

export const load: PageLoad = async ({ fetch, params }) => {
	const response = await fetch(`${base}/api/cases/${params.id}`);
	const payload = await response.json();
	if (!response.ok || !payload.ok) error(response.status, payload.error?.message ?? '案例不存在');
	const view = payload.data as CaseView;
	let previousGuidance: GuidanceSnapshot | null = null;
	if (view.mode === 'guided' && !view.guidance && view.guidanceHistory.length) {
		const latest = view.guidanceHistory.at(-1);
		if (latest) {
			const detailResponse = await fetch(`${base}/api/cases/${params.id}/guidance/${latest.id}`);
			const detailPayload = await detailResponse.json();
			if (detailResponse.ok && detailPayload.ok) {
				previousGuidance = detailPayload.data as GuidanceSnapshot;
			}
		}
	}
	return { view, previousGuidance };
};
