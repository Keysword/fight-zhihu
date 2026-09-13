import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { guidanceModeEnabled } from '$lib/server/app-context';

export const load: LayoutServerLoad = () => ({
	mode: guidanceModeEnabled(env.BACKGROUND_BOARD_GUIDANCE_V2) ? 'guided' : 'legacy'
});
