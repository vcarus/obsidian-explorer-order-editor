/**
 * Pure front matter locate/splice logic for the `sorting-spec` key.
 *
 * Must not import `obsidian` (vitest cannot resolve it). The YAML parser is
 * injected via `deps.parseYaml`: production passes Obsidian's `parseYaml`,
 * tests pass `parse` from the `yaml` package.
 *
 * Two views, never confused:
 * - Semantic view (`readSortingSpecValue`): `parseYaml`s the whole front
 *   matter block and asks "what is the value of sorting-spec". This is
 *   exactly what custom-sort sees, and all decisions about *content* come
 *   from here.
 * - Syntactic view (internal key scanner): finds only the *line range* a
 *   top-level key's value occupies, never a value. Used to know what text to
 *   splice out/in, without re-serializing anything we don't have to.
 */

import { canonicalizeSortingSpec } from './sortspec';

export interface FrontMatterDeps {
	readonly parseYaml: (source: string) => unknown;
}

export type FrontMatterErrorCode = 'unsupported-shape' | 'duplicate-key' | 'invalid-yaml' | 'verification-failed';

export class FrontMatterError extends Error {
	readonly code: FrontMatterErrorCode;

	constructor(code: FrontMatterErrorCode, message?: string) {
		super(message ?? code);
		this.name = 'FrontMatterError';
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Physical line splitting (terminator-preserving, for byte-exact splicing)
// ---------------------------------------------------------------------------

export interface PhysicalLine {
	readonly text: string;
	/** '', '\n', '\r', or '\r\n' — whatever ended this physical line in the source. */
	readonly terminator: string;
}

function splitPhysicalLines(text: string): PhysicalLine[] {
	if (text === '') return [];
	const result: PhysicalLine[] = [];
	let i = 0;
	let lineStart = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\r') {
			const terminator = text[i + 1] === '\n' ? '\r\n' : '\r';
			result.push({ text: text.slice(lineStart, i), terminator });
			i += terminator.length;
			lineStart = i;
		} else if (ch === '\n') {
			result.push({ text: text.slice(lineStart, i), terminator: '\n' });
			i += 1;
			lineStart = i;
		} else {
			i += 1;
		}
	}
	if (lineStart < text.length) {
		result.push({ text: text.slice(lineStart), terminator: '' });
	}
	return result;
}

function joinPhysicalLines(lines: readonly PhysicalLine[]): string {
	let out = '';
	for (const line of lines) {
		out += line.text + line.terminator;
	}
	return out;
}

function detectDominantTerminator(lines: readonly PhysicalLine[]): '\n' | '\r\n' {
	for (const line of lines) {
		if (line.terminator === '\r\n') return '\r\n';
		if (line.terminator === '\n') return '\n';
	}
	return '\n';
}

// ---------------------------------------------------------------------------
// locateFrontMatter
// ---------------------------------------------------------------------------

export interface FrontMatterFound {
	readonly kind: 'found';
	readonly bom: string;
	readonly lines: readonly PhysicalLine[];
	readonly openIndex: number;
	readonly closeIndex: number;
	/** Text of the yaml block (lines between the delimiters), reconstructed with original terminators. */
	readonly yamlText: string;
}

export interface FrontMatterNone {
	readonly kind: 'none';
	readonly bom: string;
	readonly lines: readonly PhysicalLine[];
}

export type FrontMatterLocation = FrontMatterFound | FrontMatterNone;

export function locateFrontMatter(raw: string): FrontMatterLocation {
	const bom = raw.startsWith('﻿') ? '﻿' : '';
	const body = raw.slice(bom.length);
	const lines = splitPhysicalLines(body);

	if (lines.length === 0) return { kind: 'none', bom, lines };
	if (lines[0]?.text !== '---') return { kind: 'none', bom, lines };

	let closeIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.text === '---') {
			closeIndex = i;
			break;
		}
	}
	if (closeIndex === -1) {
		// Unclosed opening `---` -> treat as no front matter.
		return { kind: 'none', bom, lines };
	}

	const yamlLines = lines.slice(1, closeIndex);
	return {
		kind: 'found',
		bom,
		lines,
		openIndex: 0,
		closeIndex,
		yamlText: joinPhysicalLines(yamlLines),
	};
}

// ---------------------------------------------------------------------------
// Semantic view
// ---------------------------------------------------------------------------

export type ReadSortingSpecResult =
	| { readonly status: 'no-frontmatter' }
	| { readonly status: 'invalid-yaml' }
	| { readonly status: 'absent' }
	| { readonly status: 'non-string' }
	| { readonly status: 'ok'; readonly value: string };

const SORTING_SPEC_KEY = 'sorting-spec';

type FrontMatterParseResult =
	| { readonly status: 'no-frontmatter' }
	| { readonly status: 'invalid-yaml' }
	| { readonly status: 'parsed'; readonly obj: Record<string, unknown> };

function parseFrontMatterObject(location: FrontMatterLocation, deps: FrontMatterDeps): FrontMatterParseResult {
	if (location.kind === 'none') return { status: 'no-frontmatter' };
	let parsed: unknown;
	try {
		parsed = deps.parseYaml(location.yamlText);
	} catch {
		return { status: 'invalid-yaml' };
	}
	if (parsed === null || parsed === undefined) return { status: 'parsed', obj: {} };
	if (typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'parsed', obj: {} };
	return { status: 'parsed', obj: parsed as Record<string, unknown> };
}

export function readSortingSpecValue(raw: string, deps: FrontMatterDeps): ReadSortingSpecResult {
	const location = locateFrontMatter(raw);
	const parsed = parseFrontMatterObject(location, deps);
	if (parsed.status === 'no-frontmatter') return { status: 'no-frontmatter' };
	if (parsed.status === 'invalid-yaml') return { status: 'invalid-yaml' };

	if (!(SORTING_SPEC_KEY in parsed.obj)) return { status: 'absent' };
	const value = parsed.obj[SORTING_SPEC_KEY];
	if (typeof value !== 'string') return { status: 'non-string' };
	return { status: 'ok', value };
}

function deepEqualExceptKey(a: unknown, b: unknown, excludeKey: string): boolean {
	const strip = (v: unknown): unknown => {
		if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
			const clone: Record<string, unknown> = { ...(v as Record<string, unknown>) };
			delete clone[excludeKey];
			return clone;
		}
		return v;
	};
	return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

// ---------------------------------------------------------------------------
// Syntactic view: top-level key scanner
// ---------------------------------------------------------------------------

interface TopLevelKeyLine {
	readonly name: string;
	readonly lineIndex: number;
	/** Text after the key's colon, on the key's own line, untrimmed. */
	readonly restRaw: string;
}

/** Strips a single layer of surrounding quotes from a YAML key token, if present. */
function unquoteKeyToken(token: string): string {
	if (token.length >= 2 && token[0] === '"' && token[token.length - 1] === '"') {
		return token.slice(1, -1).replace(/\\"/g, '"');
	}
	if (token.length >= 2 && token[0] === "'" && token[token.length - 1] === "'") {
		return token.slice(1, -1).replace(/''/g, "'");
	}
	return token;
}

/** Recognizes a line as `key: rest` or `key:` at column 0. Returns null if it isn't a key line. */
function matchTopLevelKeyLine(text: string): { name: string; restRaw: string } | null {
	if (text.length === 0) return null;
	const first = text[0];
	if (first === ' ' || first === '\t' || first === '#' || first === '-') return null;

	let nameToken: string;
	let colonIndex: number;
	if (first === '"' || first === "'") {
		const quote = first;
		let i = 1;
		let closed = false;
		while (i < text.length) {
			const ch = text[i];
			if (quote === '"' && ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === quote) {
				if (quote === "'" && text[i + 1] === "'") {
					i += 2;
					continue;
				}
				closed = true;
				break;
			}
			i += 1;
		}
		if (!closed) return null;
		nameToken = text.slice(0, i + 1);
		colonIndex = i + 1;
		if (text[colonIndex] !== ':') return null;
	} else {
		const idx = text.indexOf(':');
		if (idx === -1) return null;
		nameToken = text.slice(0, idx);
		colonIndex = idx;
	}

	const afterColon = text[colonIndex + 1];
	if (afterColon !== undefined && afterColon !== ' ' && afterColon !== '\t') return null;

	return { name: unquoteKeyToken(nameToken), restRaw: text.slice(colonIndex + 1) };
}

function findTopLevelKeys(lines: readonly PhysicalLine[]): TopLevelKeyLine[] {
	const keys: TopLevelKeyLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i]?.text ?? '';
		const match = matchTopLevelKeyLine(text);
		if (match !== null) {
			keys.push({ name: match.name, lineIndex: i, restRaw: match.restRaw });
		}
	}
	return keys;
}

function nextLineIsColumnZeroDash(lines: readonly PhysicalLine[], keyLineIndex: number): boolean {
	const next = lines[keyLineIndex + 1];
	if (next === undefined) return false;
	const text = next.text;
	if (text.length === 0) return false;
	const first = text[0];
	if (first === ' ' || first === '\t') return false;
	return text === '-' || text.startsWith('- ');
}

function scanColumnZeroSequence(lines: readonly PhysicalLine[], keyLineIndex: number): number {
	let i = keyLineIndex + 1;
	while (i < lines.length) {
		const text = lines[i]?.text ?? '';
		if (text.trim() === '') {
			i += 1;
			continue;
		}
		const first = text[0];
		if (first === ' ' || first === '\t') {
			i += 1;
			continue;
		}
		if (text === '-' || text.startsWith('- ')) {
			i += 1;
			continue;
		}
		break;
	}
	return i;
}

function scanIndentedContinuation(lines: readonly PhysicalLine[], keyLineIndex: number): number {
	let i = keyLineIndex + 1;
	while (i < lines.length) {
		const text = lines[i]?.text ?? '';
		if (text.trim() === '') {
			i += 1;
			continue;
		}
		const first = text[0];
		if (first === ' ' || first === '\t') {
			i += 1;
			continue;
		}
		break;
	}
	return i;
}

function scanQuoted(lines: readonly PhysicalLine[], keyLineIndex: number, restRaw: string, quote: '"' | "'"): number {
	const startLineText = lines[keyLineIndex]?.text ?? '';
	const restStart = startLineText.length - restRaw.length;
	const quoteCol = restStart + (restRaw.length - restRaw.trimStart().length);

	let li = keyLineIndex;
	let ci = quoteCol + 1;
	while (li < lines.length) {
		const text = lines[li]?.text ?? '';
		while (ci < text.length) {
			const ch = text[ci];
			if (quote === '"') {
				if (ch === '\\') {
					ci += 2;
					continue;
				}
				if (ch === '"') return li + 1;
			} else {
				if (ch === "'") {
					if (text[ci + 1] === "'") {
						ci += 2;
						continue;
					}
					return li + 1;
				}
			}
			ci += 1;
		}
		li += 1;
		ci = 0;
	}
	return lines.length;
}

function scanFlow(lines: readonly PhysicalLine[], keyLineIndex: number, restRaw: string): number {
	const startLineText = lines[keyLineIndex]?.text ?? '';
	const restStart = startLineText.length - restRaw.length;
	const openCol = restStart + (restRaw.length - restRaw.trimStart().length);

	let depth = 0;
	let li = keyLineIndex;
	let ci = openCol;
	let inQuote: '"' | "'" | null = null;
	while (li < lines.length) {
		const text = lines[li]?.text ?? '';
		while (ci < text.length) {
			const ch = text[ci];
			if (inQuote !== null) {
				if (inQuote === '"' && ch === '\\') {
					ci += 2;
					continue;
				}
				if (ch === inQuote) {
					if (inQuote === "'" && text[ci + 1] === "'") {
						ci += 2;
						continue;
					}
					inQuote = null;
				}
				ci += 1;
				continue;
			}
			if (ch === '"' || ch === "'") {
				inQuote = ch;
				ci += 1;
				continue;
			}
			if (ch === '[' || ch === '{') depth += 1;
			if (ch === ']' || ch === '}') {
				depth -= 1;
				if (depth === 0) return li + 1;
			}
			ci += 1;
		}
		li += 1;
		ci = 0;
	}
	return lines.length;
}

/** Extracts a same-line trailing comment for the simple `key: <indicator>? <comment>?` shapes we ourselves write. */
function extractTrailingComment(restRaw: string): string {
	const trimmed = restRaw.trim();
	const match = /^([|>][+-]?\d*)?\s*(#.*)?$/.exec(trimmed);
	if (match?.[2] !== undefined) return ' ' + match[2];
	return '';
}

interface KeyExtent {
	readonly startLine: number;
	/** Exclusive end index into `lines`. */
	readonly endLine: number;
	readonly trailingComment: string;
}

function extentOfKey(lines: readonly PhysicalLine[], key: TopLevelKeyLine): KeyExtent {
	const restTrimmed = key.restRaw.trim();
	let end: number;

	if (restTrimmed.startsWith('"')) {
		end = scanQuoted(lines, key.lineIndex, key.restRaw, '"');
	} else if (restTrimmed.startsWith("'")) {
		end = scanQuoted(lines, key.lineIndex, key.restRaw, "'");
	} else if (restTrimmed.startsWith('[') || restTrimmed.startsWith('{')) {
		end = scanFlow(lines, key.lineIndex, key.restRaw);
	} else if (restTrimmed === '' && nextLineIsColumnZeroDash(lines, key.lineIndex)) {
		end = scanColumnZeroSequence(lines, key.lineIndex);
	} else {
		end = scanIndentedContinuation(lines, key.lineIndex);
	}

	while (end - 1 > key.lineIndex && (lines[end - 1]?.text.trim() ?? '') === '') {
		end -= 1;
	}

	return { startLine: key.lineIndex, endLine: end, trailingComment: extractTrailingComment(key.restRaw) };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function buildValueLines(newValue: string, trailingComment: string, terminator: string): PhysicalLine[] {
	const valueLines = newValue === '' ? [] : newValue.split('\n');
	const out: PhysicalLine[] = [
		{ text: `${SORTING_SPEC_KEY}: |${trailingComment}`, terminator },
	];
	for (const line of valueLines) {
		out.push({ text: `  ${line}`, terminator });
	}
	return out;
}

function verifyReplacement(
	result: string,
	deps: FrontMatterDeps,
	newValue: string,
	originalOther: unknown,
): void {
	const read = readSortingSpecValue(result, deps);
	// A `|` (clip) block scalar always reads back with a single trailing
	// newline when non-empty; compare canonical forms rather than raw bytes.
	if (read.status !== 'ok' || canonicalizeSortingSpec(read.value) !== canonicalizeSortingSpec(newValue)) {
		throw new FrontMatterError('verification-failed', 'sorting-spec value does not match after write');
	}
	const location = locateFrontMatter(result);
	const parsed = parseFrontMatterObject(location, deps);
	const updatedOther = parsed.status === 'parsed' ? parsed.obj : {};
	if (!deepEqualExceptKey(originalOther, updatedOther, SORTING_SPEC_KEY)) {
		throw new FrontMatterError('verification-failed', 'unrelated front matter keys changed after write');
	}
}

export function replaceSortingSpecInFile(raw: string, newValue: string, deps: FrontMatterDeps): string {
	const location = locateFrontMatter(raw);

	if (location.kind === 'none') {
		// No (usable) front matter: create one, keep the original content as the body untouched.
		const terminator = '\n';
		const original = raw; // byte-identical body, appended verbatim
		const valueLines = buildValueLines(newValue, '', terminator);
		const header = ['---', ...valueLines.map((l) => l.text), '---'].join(terminator) + terminator;
		const result = header + original;
		verifyReplacement(result, deps, newValue, {});
		return result;
	}

	// The syntactic duplicate-key check runs on the raw text, independent of
	// how (or whether) `deps.parseYaml` copes with duplicate keys — some
	// parsers throw on them, which would otherwise get misreported as
	// generic invalid-yaml instead of the more actionable duplicate-key.
	const yamlLines = location.lines.slice(location.openIndex + 1, location.closeIndex);
	const keys = findTopLevelKeys(yamlLines);
	const sortingSpecKeys = keys.filter((k) => k.name === SORTING_SPEC_KEY);
	if (sortingSpecKeys.length > 1) {
		throw new FrontMatterError('duplicate-key');
	}

	const parsed = parseFrontMatterObject(location, deps);
	if (parsed.status === 'invalid-yaml') {
		throw new FrontMatterError('invalid-yaml');
	}

	const originalOther = parsed.status === 'parsed' ? parsed.obj : {};

	const semanticHasValue = parsed.status === 'parsed' && SORTING_SPEC_KEY in parsed.obj;
	if (semanticHasValue !== (sortingSpecKeys.length === 1)) {
		throw new FrontMatterError('unsupported-shape');
	}

	const terminator = detectDominantTerminator(location.lines);
	const newLines = location.lines.slice();

	if (sortingSpecKeys.length === 1) {
		const key = sortingSpecKeys[0];
		if (key === undefined) throw new FrontMatterError('unsupported-shape');
		const extent = extentOfKey(yamlLines, key);
		const absoluteStart = location.openIndex + 1 + extent.startLine;
		const absoluteEnd = location.openIndex + 1 + extent.endLine;
		const replacement = buildValueLines(newValue, extent.trailingComment, terminator);
		newLines.splice(absoluteStart, absoluteEnd - absoluteStart, ...replacement);
	} else {
		// Not present yet: insert as the last key in the front matter block, right before the closing `---`.
		const replacement = buildValueLines(newValue, '', terminator);
		newLines.splice(location.closeIndex, 0, ...replacement);
	}

	const result = location.bom + joinPhysicalLines(newLines);
	verifyReplacement(result, deps, newValue, originalOther);
	return result;
}

export function removeSortingSpecFromFile(raw: string, deps: FrontMatterDeps): string {
	const location = locateFrontMatter(raw);
	if (location.kind === 'none') return raw;

	// Syntactic duplicate-key check first, independent of `deps.parseYaml`'s
	// own handling of duplicate keys (see replaceSortingSpecInFile).
	const yamlLines = location.lines.slice(location.openIndex + 1, location.closeIndex);
	const keys = findTopLevelKeys(yamlLines);
	const sortingSpecKeys = keys.filter((k) => k.name === SORTING_SPEC_KEY);
	if (sortingSpecKeys.length > 1) {
		throw new FrontMatterError('duplicate-key');
	}

	const parsed = parseFrontMatterObject(location, deps);
	if (parsed.status === 'invalid-yaml') {
		throw new FrontMatterError('invalid-yaml');
	}
	if (parsed.status === 'parsed' && !(SORTING_SPEC_KEY in parsed.obj)) return raw;

	const originalOther = parsed.status === 'parsed' ? parsed.obj : {};

	if (sortingSpecKeys.length === 0) {
		throw new FrontMatterError('unsupported-shape');
	}

	const key = sortingSpecKeys[0];
	if (key === undefined) throw new FrontMatterError('unsupported-shape');
	const extent = extentOfKey(yamlLines, key);
	const remainingYamlLines = [...yamlLines.slice(0, extent.startLine), ...yamlLines.slice(extent.endLine)];

	const wholeBlockBlank = remainingYamlLines.every((l) => l.text.trim() === '');

	let newLines: PhysicalLine[];
	if (wholeBlockBlank) {
		// Delete the whole front matter block (both delimiters and any residual blank lines).
		newLines = [...location.lines.slice(0, location.openIndex), ...location.lines.slice(location.closeIndex + 1)];
	} else {
		newLines = [
			...location.lines.slice(0, location.openIndex + 1),
			...remainingYamlLines,
			...location.lines.slice(location.closeIndex),
		];
	}

	if (newLines.length === 0) return '';

	const result = location.bom + joinPhysicalLines(newLines);

	const verifyRead = readSortingSpecValue(result, deps);
	if (verifyRead.status === 'ok' || verifyRead.status === 'non-string') {
		throw new FrontMatterError('verification-failed', 'sorting-spec key still present after removal');
	}
	const verifyLocation = locateFrontMatter(result);
	const verifyParsed = parseFrontMatterObject(verifyLocation, deps);
	const updatedOther = verifyParsed.status === 'parsed' ? verifyParsed.obj : {};
	if (!deepEqualExceptKey(originalOther, updatedOther, SORTING_SPEC_KEY)) {
		throw new FrontMatterError('verification-failed', 'unrelated front matter keys changed after removal');
	}

	return result;
}
