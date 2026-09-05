import { base } from '$app/paths';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { CaseView } from '$lib/server/services/case-service';

export const load: PageLoad = async ({ fetch, params }) => {
	const response = await fetch(`${base}/api/cases/${params.id}`);
	const payload = await response.json();
	if (!response.ok || !payload.ok) error(response.status, payload.error?.message ?? '案例不存在');
	return { view: payload.data as CaseView };
};
