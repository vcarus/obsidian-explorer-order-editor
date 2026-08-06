/**
 * Pure data layer for sortspec.md's `sorting-spec` YAML scalar value.
 *
 * Zero imports except `./types`. Synchronous, no I/O. Everything here operates
 * on the already-extracted string value of the `sorting-spec` front matter key
 * (see `frontmatter.ts` for locating/extracting that string from a raw file).
 *
 * Canonical-value invariant: a spec value in memory contains no `\r`, has no
 * trailing newline, and no trailing blank lines. `parseSortingSpec` normalizes
 * to it on the way in; `serializeSortingSpec` maintains it by construction
 * (sections never end with a blank rawLine, and appended sections carry no
 * leading blank-line separator).
 */

import type { Entry, EntryKind } from './types';

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type TargetKind = 'path' | 'root' | 'dot' | 'wildcard' | 'dead' | 'empty';

export interface TargetRef {
	/** How this target's value was classified. */
	readonly kind: TargetKind;
	/** The literal value text as written after `target-folder:`/`::::`, trimmed. */
	readonly raw: string;
	/**
	 * The canonical folder key this target matches, or `null` if it can never
	 * match a real folder (wildcard/dead/empty) or its resolution is unknown
	 * (`dot` with no `specFolder` supplied). Convention: `/` for the vault
	 * root, otherwise a slash-separated path with no leading or trailing
	 * slash. Matching is case-sensitive exact string equality against this
	 * value — never against `raw`.
	 */
	readonly resolved: string | null;
}

/**
 * Classifies a single target value (the text after `target-folder:`/`::::`,
 * already trimmed) per the normalization rules:
 * - `/` -> root
 * - `.` -> dot, resolved against `specFolder` when known
 * - contains `...` -> wildcard (unevaluable, never matches)
 * - starts with `/` (and isn't exactly `/`) -> dead (custom-sort never
 *   matches a leading-slash sub-path, so this section can never fire)
 * - otherwise -> path, trailing slashes stripped
 */
export function normalizeTarget(value: string, specFolder: string | null): TargetRef {
	if (value === '') return { kind: 'empty', raw: value, resolved: null };
	if (value === '/') return { kind: 'root', raw: value, resolved: '/' };
	if (value === '.') return { kind: 'dot', raw: value, resolved: specFolder };
	if (value.includes('...')) return { kind: 'wildcard', raw: value, resolved: null };
	if (value.startsWith('/')) return { kind: 'dead', raw: value, resolved: null };
	const resolved = value.replace(/\/+$/, '');
	return { kind: 'path', raw: value, resolved };
}

// ---------------------------------------------------------------------------
// Sections / ParsedSpec
// ---------------------------------------------------------------------------

export interface Section {
	/** The literal source lines this section was parsed/authored from, verbatim, in order. */
	readonly rawLines: readonly string[];
	/** One entry per consecutive `target-folder:`/`::::` header line, in order. */
	readonly targets: readonly TargetRef[];
	/** True iff the line immediately after the last target line is exactly `// explorer-order-editor`. */
	readonly authored: boolean;
}

export interface ParsedSpec {
	/** Lines that appear before the first target header, verbatim. */
	readonly prologue: readonly string[];
	readonly sections: readonly Section[];
	/**
	 * The folder that contains the sortspec.md this value came from, in the
	 * same canonical-key convention as `TargetRef.resolved` (`/` for root,
	 * otherwise a slash-separated path). `null` if unknown, in which case
	 * `.` targets are unresolved.
	 */
	readonly specFolder: string | null;
}

export const AUTHORED_MARKER = '// explorer-order-editor';

function toCanonicalLines(value: string): string[] {
	const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	if (normalized === '') return [];
	const lines = normalized.split('\n');
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
		lines.pop();
	}
	return lines;
}

/** Applies the canonical-value normalization (CRLF/CR -> LF, drop trailing blank lines) without parsing. */
export function canonicalizeSortingSpec(value: string): string {
	return toCanonicalLines(value).join('\n');
}

function isBlankLine(line: string): boolean {
	return line.trim() === '';
}

function isCommentLine(line: string): boolean {
	return line.trim().startsWith('//');
}

/** Returns the target value if `line` is an indentation-0 target header, else null. */
function tryParseTargetHeader(line: string, specFolder: string | null): TargetRef | null {
	if (line.length === 0) return null;
	const first = line[0];
	if (first === ' ' || first === '\t') return null; // indented -> body line, not a header

	let rest: string | null = null;
	if (line.startsWith('target-folder:')) {
		rest = line.slice('target-folder:'.length);
	} else if (line.startsWith('::::')) {
		rest = line.slice('::::'.length);
	}
	if (rest === null) return null;
	return normalizeTarget(rest.trim(), specFolder);
}

export function parseSortingSpec(value: string, specFolder?: string): ParsedSpec {
	const resolvedSpecFolder = specFolder ?? null;
	const lines = toCanonicalLines(value);

	const prologue: string[] = [];
	const sections: Section[] = [];

	let currentLines: string[] | null = null;
	let currentTargets: TargetRef[] | null = null;
	let lastTargetIndex = -1;
	let sawInstruction = false;

	const closeCurrent = (): void => {
		if (currentLines !== null && currentTargets !== null) {
			const authored = currentLines[lastTargetIndex + 1] === AUTHORED_MARKER;
			sections.push({ rawLines: currentLines, targets: currentTargets, authored });
		}
		currentLines = null;
		currentTargets = null;
		lastTargetIndex = -1;
		sawInstruction = false;
	};

	for (const line of lines) {
		const header = tryParseTargetHeader(line, resolvedSpecFolder);
		if (header !== null) {
			if (currentLines !== null && currentTargets !== null && !sawInstruction) {
				// Consecutive target line with nothing (but blanks/comments) since
				// the last one: extend as a multi-target section.
				lastTargetIndex = currentLines.length;
				currentLines.push(line);
				currentTargets.push(header);
			} else {
				closeCurrent();
				currentLines = [line];
				currentTargets = [header];
				lastTargetIndex = 0;
				sawInstruction = false;
			}
			continue;
		}

		if (currentLines === null) {
			prologue.push(line);
			continue;
		}

		currentLines.push(line);
		if (!isBlankLine(line) && !isCommentLine(line)) {
			sawInstruction = true;
		}
	}
	closeCurrent();

	return { prologue, sections, specFolder: resolvedSpecFolder };
}

export function serializeSortingSpec(spec: ParsedSpec): string {
	const lines: string[] = [...spec.prologue];
	for (const section of spec.sections) {
		lines.push(...section.rawLines);
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Name encoding
// ---------------------------------------------------------------------------

export type UnencodableReason = 'empty' | 'whitespace' | 'newline' | 'wildcard' | 'backslash';

export type EncodeEntryResult =
	| { readonly ok: true; readonly line: string }
	| { readonly ok: false; readonly reason: UnencodableReason };

export type NameIndex = ReadonlyMap<string, ReadonlySet<EntryKind>>;

export function buildNameIndex(siblings: readonly Entry[]): NameIndex {
	const map = new Map<string, Set<EntryKind>>();
	for (const sibling of siblings) {
		const kinds = map.get(sibling.name) ?? new Set<EntryKind>();
		kinds.add(sibling.kind);
		map.set(sibling.name, kinds);
	}
	return map;
}

const RESERVED_TOKENS: ReadonlySet<string> = new Set([
	'/',
	'/folders',
	'/:',
	'/:files',
	'/:.',
	'/:files.',
	'%',
	'/%',
	'/%.',
	'/folders:files',
	'/folders:files.',
	'--%',
	'/--hide:',
	'/!',
	'/!!',
	'/!!!',
	'/+',
]);

const ATTRIBUTE_LEXEMES: readonly string[] = [
	'target-folder:',
	'::::',
	'order-asc:',
	'order-desc:',
	'sorting:',
	'<',
	'>',
	'\\<',
	'\\>',
	'with-metadata:',
	'bookmarked:',
	'with-icon:',
];

function needsTypePrefix(entry: Entry, index: NameIndex): boolean {
	const name = entry.name;

	// 1. A folder and a file in this folder share the name.
	const kinds = index.get(name);
	if (kinds !== undefined && kinds.size > 1) return true;

	// 2. First space-delimited token is a reserved token.
	const firstToken = name.split(/\s/)[0] ?? '';
	if (RESERVED_TOKENS.has(firstToken)) return true;

	// 3. Starts with an attribute lexeme.
	for (const lexeme of ATTRIBUTE_LEXEMES) {
		if (name.startsWith(lexeme)) return true;
	}

	// 4. Conservative catch-all.
	const first = name[0];
	if (first !== undefined && '/%<>:\\'.includes(first)) return true;
	if (name.startsWith('--')) return true;

	return false;
}

export function encodeEntry(entry: Entry, index: NameIndex): EncodeEntryResult {
	const name = entry.name;

	if (name === '') return { ok: false, reason: 'empty' };
	if (name.trim() !== name) return { ok: false, reason: 'whitespace' };
	if (name.includes('\n') || name.includes('\r')) return { ok: false, reason: 'newline' };
	if (name.includes('...')) return { ok: false, reason: 'wildcard' };
	if (name.includes('\\')) return { ok: false, reason: 'backslash' };

	if (needsTypePrefix(entry, index)) {
		const prefix = entry.kind === 'folder' ? '/folders ' : '/:files ';
		return { ok: true, line: `${prefix}${name}` };
	}
	return { ok: true, line: name };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type MutationStatus = 'replaced' | 'appended' | 'removed' | 'unchanged' | 'blocked';

export type Diagnostic =
	| { readonly kind: 'multi-target-conflict'; readonly targets: readonly string[] }
	| { readonly kind: 'duplicate-section'; readonly count: number }
	| { readonly kind: 'foreign-section-replaced' }
	| { readonly kind: 'unrepresentable-entry'; readonly name: string; readonly reason: UnencodableReason };

export interface MutationResult {
	readonly spec: ParsedSpec;
	readonly status: MutationStatus;
	readonly diagnostics: readonly Diagnostic[];
}

function buildAuthoredSection(target: TargetRef, encodedLines: readonly string[]): Section {
	const targetLine = `target-folder: ${target.raw}`;
	return {
		rawLines: [targetLine, AUTHORED_MARKER, ...encodedLines],
		targets: [target],
		authored: true,
	};
}

function rawLinesEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

interface SectionMatch {
	readonly section: Section;
	readonly index: number;
}

function findMatches(spec: ParsedSpec, resolvedTarget: string | null): SectionMatch[] {
	if (resolvedTarget === null) return [];
	const matches: SectionMatch[] = [];
	spec.sections.forEach((section, index) => {
		if (section.targets.some((t) => t.resolved === resolvedTarget)) {
			matches.push({ section, index });
		}
	});
	return matches;
}

export function upsertFolderOrder(spec: ParsedSpec, targetRaw: string, entries: readonly Entry[]): MutationResult {
	const target = normalizeTarget(targetRaw.trim(), spec.specFolder);
	const matches = findMatches(spec, target.resolved);

	const multiTargetMatch = matches.find((m) => m.section.targets.length > 1);
	if (multiTargetMatch !== undefined) {
		return {
			spec,
			status: 'blocked',
			diagnostics: [{ kind: 'multi-target-conflict', targets: multiTargetMatch.section.targets.map((t) => t.raw) }],
		};
	}

	// All remaining matches are single-target sections that exactly match.
	const singleMatches = matches;
	const foreignMatches = singleMatches.filter((m) => !m.section.authored);
	const authoredMatches = singleMatches.filter((m) => m.section.authored);

	if (singleMatches.length > 1 && foreignMatches.length > 0) {
		return {
			spec,
			status: 'blocked',
			diagnostics: [{ kind: 'duplicate-section', count: singleMatches.length }],
		};
	}

	const nameIndex = buildNameIndex(entries);
	const encodedLines: string[] = [];
	const entryDiagnostics: Diagnostic[] = [];
	for (const entry of entries) {
		const result = encodeEntry(entry, nameIndex);
		if (result.ok) {
			encodedLines.push(result.line);
		} else {
			entryDiagnostics.push({ kind: 'unrepresentable-entry', name: entry.name, reason: result.reason });
		}
	}

	if (singleMatches.length === 0) {
		const newSection = buildAuthoredSection(target, encodedLines);
		const newSpec: ParsedSpec = { ...spec, sections: [...spec.sections, newSection] };
		return { spec: newSpec, status: 'appended', diagnostics: entryDiagnostics };
	}

	if (singleMatches.length === 1) {
		const match = singleMatches[0];
		if (match === undefined) throw new Error('unreachable');
		const newSection = buildAuthoredSection(target, encodedLines);
		if (rawLinesEqual(newSection.rawLines, match.section.rawLines)) {
			return { spec, status: 'unchanged', diagnostics: entryDiagnostics };
		}
		const newSections = spec.sections.slice();
		newSections[match.index] = newSection;
		const diagnostics = match.section.authored
			? entryDiagnostics
			: [{ kind: 'foreign-section-replaced' as const }, ...entryDiagnostics];
		return { spec: { ...spec, sections: newSections }, status: 'replaced', diagnostics };
	}

	// singleMatches.length > 1, all authored: keep the last, delete the earlier ones.
	const last = authoredMatches[authoredMatches.length - 1];
	if (last === undefined) throw new Error('unreachable');
	const newSection = buildAuthoredSection(target, encodedLines);
	const deleteIndices = new Set(authoredMatches.slice(0, -1).map((m) => m.index));
	const newSections: Section[] = [];
	spec.sections.forEach((section, index) => {
		if (deleteIndices.has(index)) return;
		if (index === last.index) {
			newSections.push(newSection);
			return;
		}
		newSections.push(section);
	});
	return { spec: { ...spec, sections: newSections }, status: 'replaced', diagnostics: entryDiagnostics };
}

export function removeFolderOrder(spec: ParsedSpec, targetRaw: string): MutationResult {
	const target = normalizeTarget(targetRaw.trim(), spec.specFolder);
	const matches = findMatches(spec, target.resolved);

	const multiTargetMatch = matches.find((m) => m.section.targets.length > 1);
	if (multiTargetMatch !== undefined) {
		return {
			spec,
			status: 'blocked',
			diagnostics: [{ kind: 'multi-target-conflict', targets: multiTargetMatch.section.targets.map((t) => t.raw) }],
		};
	}

	const authoredMatches = matches.filter((m) => m.section.authored);
	if (authoredMatches.length === 0) {
		return { spec, status: 'unchanged', diagnostics: [] };
	}

	const deleteIndices = new Set(authoredMatches.map((m) => m.index));
	const newSections = spec.sections.filter((_, index) => !deleteIndices.has(index));
	return { spec: { ...spec, sections: newSections }, status: 'removed', diagnostics: [] };
}
