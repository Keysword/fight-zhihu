import { describe, expect, it } from 'vitest';

import { parseRedactionReplacements, redactSearchQuery, redactText } from './redact';

describe('redactText', () => {
	it('redacts mainland phone numbers', () => {
		expect(redactText('电话 13812345678').redacted).toBe('电话 [手机号]');
	});

	it('redacts mainland identity numbers', () => {
		expect(redactText('身份证 320311199912312345').redacted).toBe('身份证 [证件号码]');
	});

	it('redacts email addresses', () => {
		expect(redactText('邮件 a@example.com').redacted).toBe('邮件 [邮箱]');
	});

	it('applies explicit replacements before pattern redaction', () => {
		const result = redactText('联系赵老师', [{ from: '赵老师', to: '人力老师' }]);
		expect(result.redacted).toBe('联系人力老师');
		expect(result.findings).toEqual([
			expect.objectContaining({ type: 'custom', original: '赵老师', replacement: '人力老师' })
		]);
	});

	it('records findings without altering unrelated text', () => {
		const result = redactText('请联系 13812345678 或 a@example.com，明天处理。');
		expect(result.redacted).toBe('请联系 [手机号] 或 [邮箱]，明天处理。');
		expect(result.findings.map((finding) => finding.type)).toEqual(['phone', 'email']);
	});

	it('parses user replacement lines and ignores malformed entries', () => {
		expect(parseRedactionReplacements('甲公司 => [公司]\n内部计划=某项目\n没有分隔符')).toEqual([
			{ from: '甲公司', to: '[公司]' },
			{ from: '内部计划', to: '某项目' }
		]);
	});

	it('redacts case-specific names and organizations from outbound search queries', () => {
		expect(redactSearchQuery('甲公司 张老师 13812345678 入职权限', ['张老师'])).toBe(
			'[单位] [联系人] [手机号] 入职权限'
		);
	});
});
