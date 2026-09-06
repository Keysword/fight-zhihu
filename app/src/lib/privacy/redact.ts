export type RedactionType = 'phone' | 'identity' | 'email' | 'custom';

export interface RedactionReplacement {
	from: string;
	to: string;
}

export interface RedactionFinding {
	type: RedactionType;
	original: string;
	replacement: string;
	start: number;
	end: number;
}

export interface RedactionResult {
	redacted: string;
	findings: RedactionFinding[];
}

export function parseRedactionReplacements(input: string): RedactionReplacement[] {
	return input
		.split(/\r?\n/)
		.map((line) => line.match(/^\s*(.+?)\s*(?:=>|=)\s*(.+?)\s*$/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => ({ from: match[1], to: match[2] }));
}

const RULES: Array<{ type: RedactionType; pattern: RegExp; replacement: string }> = [
	{
		type: 'identity',
		pattern:
			/(?<!\d)\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
		replacement: '[证件号码]'
	},
	{
		type: 'phone',
		pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
		replacement: '[手机号]'
	},
	{
		type: 'email',
		pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
		replacement: '[邮箱]'
	}
];

function replaceAndRecord(
	text: string,
	type: RedactionType,
	pattern: RegExp,
	replacement: string,
	findings: RedactionFinding[]
): string {
	return text.replace(pattern, (original: string, offset: number) => {
		findings.push({ type, original, replacement, start: offset, end: offset + original.length });
		return replacement;
	});
}

export function redactText(
	text: string,
	replacements: RedactionReplacement[] = []
): RedactionResult {
	const findings: RedactionFinding[] = [];
	let redacted = text;

	for (const replacement of replacements) {
		if (!replacement.from) continue;
		const escaped = replacement.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		redacted = replaceAndRecord(
			redacted,
			'custom',
			new RegExp(escaped, 'g'),
			replacement.to,
			findings
		);
	}

	for (const rule of RULES) {
		redacted = replaceAndRecord(redacted, rule.type, rule.pattern, rule.replacement, findings);
	}

	return { redacted, findings };
}

export function redactSearchQuery(query: string, caseSpecificNames: string[] = []): string {
	let redacted = redactText(query).redacted;
	for (const name of [...new Set(caseSpecificNames)].sort(
		(left, right) => right.length - left.length
	)) {
		if (name.trim().length < 2) continue;
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		redacted = redacted.replace(new RegExp(escaped, 'g'), '[联系人]');
	}
	redacted = redacted.replace(
		/[\p{Script=Han}A-Za-z0-9]{1,20}(?:公司|集团|研究所|实验室|大学|学院|项目组)/gu,
		'[单位]'
	);
	redacted = redacted.replace(/[\p{Script=Han}]{1,4}(?:老师|经理|主任|主管|总监)/gu, '[联系人]');
	return redacted.replace(/\s+/g, ' ').trim();
}
