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

/**
 * Whether `spec` has any section — single- or multi-target, ours or
 * someone else's — whose resolved target set includes `key`. Doesn't decode
 * or claim to know "the" order; just answers "does something here talk
 * about this folder at all". Used to detect a second, independent source of
 * truth for the same folder (e.g. a folder note's own `sorting-spec`
 * targeting the folder it lives in) without pretending to resolve it.
 */
export function specTargets(spec: ParsedSpec, key: string): boolean {
	return spec.sections.some((section) => section.targets.some((t) => t.resolved === key));
}

// ---------------------------------------------------------------------------
// Name index
//
// Built over a folder's live siblings so a bare, unprefixed line can be
// resolved to the right kind (see `soleKind`/`readFolderOrder` below) — the
// one thing the text of such a line can't say on its own. Originally shared
// with the old sortspec.md *encoder* (retired in M10c along with the rest of
// that write side: nothing writes that format any more), which needed the
// same lookup to decide when a name collided with a same-named sibling of
// the other kind and needed a disambiguating prefix.
// ---------------------------------------------------------------------------

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

// All 17 tokens custom-sort treats specially when one of them is the whole
// remaining text or is immediately followed by a literal space at the start
// of a sorting-group line (verified against the bundled `main.js`: its `co`
// map — group type prefixes — plus its `ao` map — priority prefixes — plus
// its `fi` array — the combine prefix). Used by `parseEntryLine` below to
// recognize bare catch-all directive lines on decode, so they aren't
// misread as a literal item name.
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

// The lexemes `parseEntryLine` (below) must recognize as "not a literal item
// name" — an instruction or attribute line instead. Built up across several
// rounds against custom-sort's own bundled parser, back when this table also
// had to serve the old encoder (retired in M10c): `with-metadata:`/
// `bookmarked:`/`with-icon:`/`/--hide:` below aren't in custom-sort's own
// attribute table, but a bare, unprefixed line starting with one of them
// still isn't a literal name `readFolderOrder` should hand back.
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
	// custom-sort's item-hide directive (verified against its bundled source:
	// `/--hide: <exact name with ext>` filters that child out of the folder's
	// rendered children before sorting even runs). The old encoder used to
	// emit this itself for the "hide sortspec.md" setting, so it must still
	// round-trip on read as an instruction, never as a literal entry name.
	// This entry only ever matters for a name that starts with `/--hide:`
	// immediately followed by more non-space text (e.g. `/--hide:foo`) — a
	// name where `/--hide:` is the *entire* first token is caught by
	// `RESERVED_TOKENS` before this list is even consulted.
	'/--hide:',
];

// The old encoder (`encodeEntry`, `needsTypePrefix`, `misparsesAsMultipleGroupPrefixes`
// and the token tables that served only them) was retired in M10c along with
// the rest of the sortspec.md write side — nothing writes that format any
// more. `ATTRIBUTE_LEXEMES` above stays because `parseEntryLine` (below,
// still needed by `readFolderOrder`) uses it to recognize an instruction
// line rather than a literal item name on *read*.

// ---------------------------------------------------------------------------
// Mutations
//
// Only `removeFolderOrder` remains as of M10c — `upsertFolderOrder` (the old
// encoder's mutation entry point, along with the section-building helpers it
// alone used) was retired with the rest of the write side. `MutationStatus`/
// `Diagnostic` are narrowed to just what `removeFolderOrder` can actually
// produce: it never returns 'replaced'/'appended' (upsert-only outcomes), and
// 'duplicate-section'/'foreign-section-replaced'/'unrepresentable-entry' were
// upsert-only diagnostics.
// ---------------------------------------------------------------------------

export type MutationStatus = 'removed' | 'unchanged' | 'blocked';

export type Diagnostic = { readonly kind: 'multi-target-conflict'; readonly targets: readonly string[] };

export interface MutationResult {
	readonly spec: ParsedSpec;
	readonly status: MutationStatus;
	readonly diagnostics: readonly Diagnostic[];
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

/**
 * Whether `spec` has a section *authored by us* (bearing `AUTHORED_MARKER`)
 * whose target set resolves to `targetRaw`. Used by the M10c sortspec.md
 * import to gate which folders' hand-authored sections get imported — only
 * ever a folder this plugin already has a section for, never a folder whose
 * sortspec.md is entirely hand-written, and never a folder with no section
 * at all. Matches on any section (single- or multi-target) the same way
 * `findMatches` does, not just single-target ones: a multi-target match is
 * still "authored" if the marker is present, even though the import (like
 * `removeFolderOrder` below) would then refuse to touch it — that refusal is
 * a separate, later check, not this function's job.
 */
export function hasAuthoredSection(spec: ParsedSpec, targetRaw: string): boolean {
	const target = normalizeTarget(targetRaw.trim(), spec.specFolder);
	return findMatches(spec, target.resolved).some((m) => m.section.authored);
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

// ---------------------------------------------------------------------------
// Decoding: reads back a previously-saved sortspec.md order, for the M10c
// one-time import into the vault-level order index. Historically this was
// also how the modal restored a folder's order on reopen; that path now goes
// through `orderIndex.ts` instead, but the decoder itself is unchanged and
// still the only way to make sense of whatever the old encoder wrote.
// ---------------------------------------------------------------------------

/** Aliases custom-sort accepts for the two type prefixes the old encoder wrote. */
const FOLDER_PREFIXES: readonly string[] = ['/folders ', '/ '];
const FILE_PREFIXES: readonly string[] = ['/:files ', '/: '];

interface ParsedEntryLine {
	readonly name: string;
	readonly kind: EntryKind;
	/**
	 * True when `kind` came from an explicit `/folders `/`/ ` or `/:files
	 * `/`/: ` prefix. False means the line was a bare, unprefixed name and
	 * `kind` is only a default guess — `readFolderOrder` can override it once
	 * it has the folder's real siblings to look the name up in.
	 */
	readonly explicit: boolean;
}

/**
 * Classifies one line from a section's body. Returns `null` for anything
 * that is not a plain item name: blank lines, `//` comments (including our
 * own `AUTHORED_MARKER`), sorting/attribute instructions (`order-asc:`,
 * `> a-z`, `< a-z`, `sorting:`, `with-metadata:`, `bookmarked:`,
 * `with-icon:`, ... — `ATTRIBUTE_LEXEMES`), bare catch-all tokens (`%`, `/%`,
 * `/folders:files`, a bare `/:files`, a bare `/folders`, ... —
 * `RESERVED_TOKENS`), anything indented (belongs to a custom-sort group, not
 * this folder's own list), and anything containing `...` (wildcard,
 * unevaluable, and never something this plugin would have written).
 *
 * Matching against `ATTRIBUTE_LEXEMES` is case-sensitive, plain `startsWith`
 * — a deliberate, narrower net than custom-sort's own case-insensitive
 * matching for the same handful of keys (the old encoder used to guard
 * against that gap on write, by prefixing any name that would otherwise be
 * misread). A foreign, hand-written line that only case-insensitively
 * resembles an attribute (e.g. `Desc something`) still decodes here as a
 * literal name, not `null`.
 *
 * Misclassifying a foreign attribute line as a name yields a *phantom* entry
 * in `readFolderOrder`'s result; every caller reconciles that result against
 * the folder's actual live children first (dropping anything no file or
 * folder actually has that name), so a phantom can never reach a write.
 */
function parseEntryLine(line: string): ParsedEntryLine | null {
	if (line.length === 0) return null;
	const first = line[0];
	if (first === ' ' || first === '\t') return null; // indented -> belongs to a group, not this folder

	const trimmed = line.trimEnd();
	if (trimmed === '') return null; // blank
	if (trimmed.startsWith('//')) return null; // comment, including AUTHORED_MARKER
	if (trimmed.includes('...')) return null; // wildcard, anywhere, is never a literal name

	for (const lexeme of ATTRIBUTE_LEXEMES) {
		if (trimmed.startsWith(lexeme)) return null; // sorting/attribute instruction
	}
	if (RESERVED_TOKENS.has(trimmed)) return null; // bare catch-all token, nothing follows it

	for (const prefix of FOLDER_PREFIXES) {
		if (trimmed.startsWith(prefix)) {
			return { name: trimmed.slice(prefix.length), kind: 'folder', explicit: true };
		}
	}
	for (const prefix of FILE_PREFIXES) {
		if (trimmed.startsWith(prefix)) {
			return { name: trimmed.slice(prefix.length), kind: 'file', explicit: true };
		}
	}

	// Bare, unprefixed name: kind is ambiguous from the text alone. Default
	// to 'file' — readFolderOrder can do better once it knows the siblings.
	return { name: trimmed, kind: 'file', explicit: false };
}

/**
 * Decodes a single line from a section body into an `Entry`, or `null` if
 * the line isn't a plain item name (see `parseEntryLine` for the exact
 * exclusions). Standalone: with no sibling context, a bare unprefixed name
 * always decodes as `kind: 'file'`. `readFolderOrder` shares the same
 * classification internally but can do better by consulting the folder's
 * actual current children.
 */
export function decodeEntryLine(line: string): Entry | null {
	const parsed = parseEntryLine(line);
	if (parsed === null) return null;
	return { name: parsed.name, kind: parsed.kind };
}

function soleKind(kinds: ReadonlySet<EntryKind> | undefined): EntryKind | null {
	if (kinds === undefined || kinds.size !== 1) return null;
	for (const kind of kinds) return kind;
	return null; // unreachable — size === 1 guarantees exactly one iteration
}

/**
 * Reads back the order stored for `targetRaw`: finds the section whose
 * target set is exactly this one resolved target — reusing `findMatches` —
 * and decodes its body in order.
 *
 * `siblings` is the folder's children, named in the *old* sortspec.md
 * convention this decoder speaks (a `.md` file stripped to its basename,
 * everything else full — see the M10c sortspec.md import, this function's
 * only remaining caller, for how it builds that list and maps the result
 * back to full names). It resolves the one thing `decodeEntryLine` can't on
 * its own: a bare, unprefixed line. The old encoder only omitted the type
 * prefix when the name didn't collide with a same-named sibling of the other
 * kind — so if exactly one kind of `siblings` entry has this name, that must
 * be the kind that was written. This is why `readFolderOrder` takes a third
 * `siblings` parameter instead of a two-arg form: without live sibling
 * context, nothing in the text of a bare line distinguishes a folder named
 * "Foo" from a file named "Foo".
 *
 * Returns `null` when there is no section whose target set is exactly
 * `targetRaw`: no match, the match is folded into a multi-target section, or
 * more than one single-target section matches (an ambiguous, hand-edited
 * duplicate). The caller must not pretend to know a single order in any of
 * those cases.
 */
export function readFolderOrder(
	spec: ParsedSpec,
	targetRaw: string,
	siblings: readonly Entry[],
): readonly Entry[] | null {
	const target = normalizeTarget(targetRaw.trim(), spec.specFolder);
	const matches = findMatches(spec, target.resolved);
	if (matches.length !== 1) return null;
	const match = matches[0];
	if (match === undefined) return null;
	if (match.section.targets.length > 1) return null; // multi-target: can't claim to know "the" order

	const siblingIndex = buildNameIndex(siblings);
	const body = match.section.rawLines.slice(1); // header is always rawLines[0] for a single-target section
	const entries: Entry[] = [];
	for (const line of body) {
		const parsed = parseEntryLine(line);
		if (parsed === null) continue;
		const kind = parsed.explicit ? parsed.kind : (soleKind(siblingIndex.get(parsed.name)) ?? parsed.kind);
		entries.push({ name: parsed.name, kind });
	}
	return entries;
}

