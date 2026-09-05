import { describe, expect, it } from 'vitest';

import { AGENT_CONSTITUTION } from './prompt';

describe('agent constitution', () => {
	it('describes the complete writable board contract and useful stopping rule', () => {
		expect(AGENT_CONSTITUTION).toContain('decisionScopes');
		expect(AGENT_CONSTITUTION).toContain('coordinationScopes');
		expect(AGENT_CONSTITUTION).toContain('relatedClaimIds');
		expect(AGENT_CONSTITUTION).toContain('contactParticipantId');
		expect(AGENT_CONSTITUTION).toContain('证据已经足够');
	});
});
