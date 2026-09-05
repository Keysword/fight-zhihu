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
