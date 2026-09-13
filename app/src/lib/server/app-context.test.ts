import { describe, expect, it } from 'vitest';

import { AgentTransportConfigurationError, guidanceModeEnabled, selectAgentTransport } from './app-context';

describe('guidance mode configuration', () => {
	it('enables the server-driven mode only for the exact value 1', () => {
		expect(guidanceModeEnabled('1')).toBe(true);
		expect(guidanceModeEnabled('true')).toBe(false);
		expect(guidanceModeEnabled('0')).toBe(false);
		expect(guidanceModeEnabled(undefined)).toBe(false);
	});
});

describe('agent transport selection', () => {
	it('keeps legacy resolution when AGENT_TRANSPORT is unset or legacy', () => {
		const legacyWithApiUrl = selectAgentTransport({
			AGENT_API_URL: 'https://legacy.example/v1/chat/completions',
			AGENT_API_KEY: 'legacy-key',
			AGENT_MODEL: 'legacy-model'
		});
		expect(legacyWithApiUrl.transport).toBe('legacy');
		expect(legacyWithApiUrl.modelConfiguration?.url).toBe('https://legacy.example/v1/chat/completions');
		expect(legacyWithApiUrl.sdkConfiguration).toBeNull();

		const zhidaFallback = selectAgentTransport({ ZHIHU_ACCESS_SECRET: 'zhihu-secret' });
		expect(zhidaFallback.transport).toBe('legacy');
		expect(zhidaFallback.modelConfiguration?.isZhihu).toBe(true);
		expect(zhidaFallback.sdkConfiguration).toBeNull();
	});

	it('selects the SDK only when explicitly enabled with a complete configuration', () => {
		const selection = selectAgentTransport({
			AGENT_TRANSPORT: 'sdk',
			AGENT_SDK_BASE_URL: 'https://provider.example/v1',
			AGENT_API_KEY: 'sdk-key',
			AGENT_MODEL: 'deepseek-v4-flash'
		});
		expect(selection.transport).toBe('sdk');
		expect(selection.sdkConfiguration).toEqual({
			baseURL: 'https://provider.example/v1',
			apiKey: 'sdk-key',
			model: 'deepseek-v4-flash',
			stream: false
		});
		expect(selection.modelConfiguration).toBeNull();
	});

	it('uses AGENT_SDK_STREAM=1 to enable streaming', () => {
		const selection = selectAgentTransport({
			AGENT_TRANSPORT: 'sdk',
			AGENT_SDK_BASE_URL: 'https://provider.example/v1',
			AGENT_API_KEY: 'sdk-key',
			AGENT_MODEL: 'deepseek-v4-flash',
			AGENT_SDK_STREAM: '1'
		});
		expect(selection.sdkConfiguration?.stream).toBe(true);
	});

	it('rejects an incomplete sdk configuration instead of falling back', () => {
		expect(() =>
			selectAgentTransport({ AGENT_TRANSPORT: 'sdk', ZHIHU_ACCESS_SECRET: 'zhihu-secret' })
		).toThrow(AgentTransportConfigurationError);
		expect(() => selectAgentTransport({ AGENT_TRANSPORT: 'sdk', AGENT_API_KEY: 'k' })).toThrow(
			/AGENT_SDK_BASE_URL、AGENT_MODEL/
		);
	});

	it('rejects an unknown transport value outright', () => {
		expect(() => selectAgentTransport({ AGENT_TRANSPORT: 'websocket' })).toThrow(
			AgentTransportConfigurationError
		);
	});

	it('rejects an invalid stream flag under sdk transport', () => {
		expect(() =>
			selectAgentTransport({
				AGENT_TRANSPORT: 'sdk',
				AGENT_SDK_BASE_URL: 'https://provider.example/v1',
				AGENT_API_KEY: 'sdk-key',
				AGENT_MODEL: 'deepseek-v4-flash',
				AGENT_SDK_STREAM: 'maybe'
			})
		).toThrow(AgentTransportConfigurationError);
	});
});
