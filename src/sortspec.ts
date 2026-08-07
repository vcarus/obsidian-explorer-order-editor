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
// Name encoding
// ---------------------------------------------------------------------------

export type UnencodableReason =
	| 'empty'
	| 'whitespace'
	| 'newline'
	| 'wildcard'
	| 'backslash'
	| 'reserved-token'
	| 'group-attribute';

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

// All 17 tokens custom-sort treats specially when one of them is the whole
// remaining text or is immediately followed by a literal space at the start
// of a sorting-group line (verified against the bundled `main.js`: its `co`
// map — group type prefixes — plus its `ao` map — priority prefixes — plus
// its `fi` array — the combine prefix). Also used unchanged by
// `parseEntryLine` below to recognize bare catch-all directive lines on
// decode; that recognition doesn't change here, only what `encodeEntry` does
// when an entry's own name happens to start with one of them.
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

// Of the 17 tokens above, these 13 are custom-sort's *sorting group type*
// prefixes — its `co` map. custom-sort allows exactly one per sorting-group
// line; a second one anywhere it's recognized as a token is
// `TooManyGroupTypePrefixes` (error 21) — the parser error from the bug this
// file fixes ("/:files --% hidden" has two: the one we inject, and "--%").
const GROUP_TYPE_PREFIX_TOKENS: readonly string[] = [
	'/folders:files.',
	'/%.',
	'/:.',
	'/:files.',
	'/:',
	'/:files',
	'/',
	'/folders',
	'%',
	'/folders:files',
	'/%',
	'--%',
	'/--hide:',
];

// The remaining 4 reserved tokens are a different class: priority prefixes
// (custom-sort's `ao` map — `/!`, `/!!`, `/!!!`) and the combine prefix
// (`fi` — `/+`). Up to one of each may legitimately appear *before* a group
// type prefix on the same line (that's their entire purpose) — but one
// appearing *after* a group type prefix is a hard parse error too
// (`PriorityPrefixAfterGroupTypePrefix` / `CombinePrefixAfterGroupTypePrefix`,
// errors 22/23), and since our injected `/folders `/`/:files ` prefix is
// itself a group type token, an entry whose own leading token is one of
// these 4 always ends up positioned *after* it. So, like the 13 above,
// prefixing cannot rescue these either.
const PRIORITY_PREFIX_TOKENS: readonly string[] = ['/!', '/!!', '/!!!'];
const COMBINE_PREFIX_TOKENS: readonly string[] = ['/+'];

// This table and LINE_ATTRIBUTE_LEXEMES below deliberately overlap (both
// list `target-folder:`, `::::`, `order-asc:`, `order-desc:`, `sorting:`,
// `<`, `>`, `\<`, `\>`). They come from two different sources of truth and
// are kept as two separate constants on purpose rather than merged into one:
// this one is *our* accumulated table of "things `encodeEntry`/`parseEntryLine`
// need to treat as an instruction, not a name" (built up across several
// rounds — see the `with-metadata:`/`bookmarked:`/`with-icon:`/`/--hide:`
// entries below, none of which are in custom-sort's `ro` map at all).
// LINE_ATTRIBUTE_LEXEMES is a verbatim transcription of custom-sort's own
// `ro` map — a narrower, differently-matched set (case-insensitive prefix,
// not case-sensitive exact-prefix) that exists purely so `needsTypePrefix`
// can be checked against custom-sort's actual data instead of our reading of
// it. Merging them would obscure which entries are "ours" vs "transcribed",
// and would force one matching rule (case-sensitive or -insensitive) onto
// lexemes that only need the other.
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
	// rendered children before sorting even runs). We emit this ourselves
	// (see `upsertFolderOrder`'s `hideNames` parameter) so it must round-trip
	// as an instruction, never as a literal entry name. Note `/--hide:` is
	// *also* one of the 13 `GROUP_TYPE_PREFIX_TOKENS` above (custom-sort's
	// `co` map serves double duty as its item-hide directive); this entry
	// only ever matters for a name that starts with `/--hide:` immediately
	// followed by more non-space text (e.g. `/--hide:foo`) — a name where
	// `/--hide:` is the *entire* first token is caught by `RESERVED_TOKENS`
	// before this list is even consulted.
	'/--hide:',
];

// Of the lexemes in ATTRIBUTE_LEXEMES above, these 3 are a different and more
// dangerous class. custom-sort's `consumeParsedSortingGroupSpec` (bundled
// `main.js`, this method starts at char offset ~32583) does its `startsWith`
// check against the *group body* — the text remaining after a group-type
// prefix (ours or the author's own) has already been stripped off — not
// against the raw line. Traced from the bundled source (names below are
// exactly as in `main.js`, since they're object properties and survive
// minification unmangled):
//
//   if (arraySpec.length === 1) {
//     let i = arraySpec[0];                  // <- already past the group-type prefix
//     if (i === "...")                     return { type: 1, ... };  // catch-all; moot here, `...` is already rejected earlier
//     if (i.startsWith("with-metadata:"))  return { type: 6, withMetadataFieldName: ... };
//     else if (i.startsWith("bookmarked:")) return { type: 7, ... };
//     else if (i.startsWith("with-icon:"))  return { type: 8, iconName: ... };
//     else                                  return { type: 2, exactText: i, ... };  // literal name
//   }
//
// Injecting `/folders `/`/:files ` does nothing to neutralize these three:
// that prefix is consumed *before* this switch runs, so `i` ends up as
// exactly the entry's own name either way. `/:files with-metadata: x` still
// hands `i = "with-metadata: x"` to this check, which still matches the
// first branch, so the line still becomes a `type: 6` metadata-match group —
// it never falls through to the `type: 2` literal-name match `encodeEntry`
// is counting on to make the prefix trick work.
//
// The failure has two layers, the second worse than the first (reproduced in
// testvault, `xss-test/with-metadata: x.md`):
//   1. The entry's own line is consumed as a match *rule*, not a name — so
//      the file/folder itself is unlisted and sorts last, same as any other
//      unrepresentable name.
//   2. Unlike a merely-dropped name, this line stays *active*: it is now a
//      live metadata/bookmark/icon-matching group for the rest of the
//      section. Any sibling that happens to satisfy it (e.g. another file in
//      the same folder with an `x` front-matter field) gets pulled into this
//      group's position — silently mis-sorting a file that was never named
//      in the spec at all.
//
// Contrast with the rest of ATTRIBUTE_LEXEMES (`target-folder:`, `::::`,
// `order-asc:`, `order-desc:`, `sorting:`, `<`, `>`, `/--hide:`): those are
// recognized as line-level or folder-level attributes in an earlier parsing
// pass, before a line is ever handed to `consumeParsedSortingGroupSpec` as a
// group body. Once our prefix routes the line into group-body parsing, they
// are just characters as far as this switch is concerned, and land on the
// `type: 2` literal-name branch like any ordinary name — prefixing them is
// genuinely safe. Verified against testvault: `xss-test/order-desc:
// a-z.md` and `xss-test/<img src=x onerror=alert(1)>.md` both sort correctly
// today with the injected `/:files ` prefix; those two names are this
// change's control group and must keep working.
const GROUP_BODY_LEXEMES: readonly string[] = ['with-metadata:', 'bookmarked:', 'with-icon:'];

// A verbatim transcription of custom-sort's own line-attribute table — its
// `ro` object (bundled `main.js`, built at char offset ~21144 as
// `ro = {...yt, ...St, ...Vn}` from three smaller maps: `yt` contributes
// `<`, `\<`, `>`, `\>`, `order-asc:`, `order-desc:`, `sorting:`; `St`
// contributes the same four symbols plus the *no-colon* forms `order-asc`,
// `order-desc`, `asc`, `desc`; `Vn` contributes `target-folder:` and `::::`).
// Confirmed by reading the bundled source directly, not from memory.
//
// `ro` feeds exactly two checks in the main per-line parse loop (the loop
// itself sits at offset ~36099: for each non-blank, non-`//` line, it tries
// `parseAttribute` first, and only if that returns null does it try
// `checkForRiskyAttrSyntaxError`):
//
//   parseAttribute(line)                          // offset ~27853
//     r = line.trimStart()
//     n = r.indexOf(" ")                          // first space in the trimmed line
//     if (n === -1) return null                   // no space anywhere -> give up
//     word = r.slice(0, n).toLowerCase()           // the whole first token, lowercased
//     if (ro[word]) { ...consume the line as an attribute (valid or not)... }
//
//   checkForRiskyAttrSyntaxError(line)             // right after parseAttribute, same region
//     whole = line.trimStart().toLowerCase()
//     for (key of Object.keys(ro))
//       if (whole.startsWith(key)) { ...report a parse problem, consume the line... }
//
// The two use different match rules — parseAttribute wants the lowercased
// *first whitespace-delimited token* to equal a key exactly (and only even
// looks if the line has a space at all); checkForRiskyAttrSyntaxError wants
// the lowercased *whole line* to merely start with a key, no word boundary
// required. But parseAttribute's condition always implies
// checkForRiskyAttrSyntaxError's: if the first token equals a key of length
// L, the line necessarily has a space at index L, so the line's first L
// characters *are* that key — precisely what checkForRiskyAttrSyntaxError
// also tests, as a plain string-prefix check that doesn't care what comes
// after. So checkForRiskyAttrSyntaxError's match set is a strict superset of
// parseAttribute's, and running both back-to-back in the real parser catches
// nothing more than "lowercase the line, then check startsWith against every
// `ro` key" would catch by itself. That single test is exactly what
// `needsTypePrefix` mirrors below — we don't need to reproduce the
// two-function split, only its union.
//
// Consequence is bad either way we can't tell apart from the name alone: a
// name that lands in parseAttribute's exact-match branch either parses as a
// valid attribute (the file/folder's own line is silently consumed as a rule,
// never listed as an item) or fails value validation and calls `problem()`;
// a name merely caught by checkForRiskyAttrSyntaxError's prefix match always
// calls `problem()`. Any `problem()` call here suspends the *entire* plugin
// (`this.settings.suspended = true` + `saveSettings()`, offset ~72365) — see
// CLAUDE.md's "无法表达的名字" section. So both outcomes are treated as
// equally unsafe; there's no such thing as "detecting the safe case and
// skipping the prefix" here, because adding the prefix is itself what makes
// the line safe (see below).
//
// The fix — prefixing works, unlike the GROUP_BODY_LEXEMES case above —
// because `parseAttribute`/`checkForRiskyAttrSyntaxError` run in an entirely
// separate, earlier pass over the *raw, unprefixed* line straight from the
// file (the main loop above), before `parseSortingGroupSpec`'s own
// group-type-prefix stripping ever runs. Once our `/folders `/`/:files `
// prefix is on the line, it's simply what `ro`'s keys are compared against
// at column 0 — the entry's own name has been pushed past where either check
// looks, and never reaches them at all. Contrast this with
// GROUP_BODY_LEXEMES, whose corresponding check runs *after* a prefix
// (ours or the author's own) has already been stripped off, so prefixing
// there gains nothing.
//
// `\<` and `\>` are kept here for a byte-for-byte-faithful transcription of
// `ro` even though neither can actually be reached through this path in
// practice: any name containing a literal backslash is already rejected by
// `encodeEntry`'s earlier `reason: 'backslash'` check, so `needsTypePrefix`
// is never even called for such a name.
const LINE_ATTRIBUTE_LEXEMES: readonly string[] = [
	'<',
	'\\<',
	'>',
	'\\>',
	'order-asc:',
	'order-desc:',
	'sorting:',
	'order-asc',
	'order-desc',
	'asc',
	'desc',
	'target-folder:',
	'::::',
];

/**
 * Mirrors the greedy, front-of-line prefix-stripping loop in custom-sort's
 * own `parseSortingGroupSpec` (bundled `main.js`, feeding the
 * `TooManyGroupTypePrefixes` / `PriorityPrefixAfterGroupTypePrefix` /
 * `CombinePrefixAfterGroupTypePrefix` checks): repeatedly, from the front of
 * the (trimmed) remaining string, it tries a priority prefix, then a combine
 * prefix, then a group-type prefix; each match consumes exactly that token
 * plus one following space, and the loop repeats on what's left, stopping
 * the moment nothing matches at the current position. A token counts as
 * matched only when it is the *entire* remaining string or is immediately
 * followed by a literal space — a token stuck to more text with no space
 * boundary is never recognized, mirroring custom-sort's own
 * `r === g || r.startsWith(g + " ")` check exactly (a literal space, not
 * general whitespace).
 *
 * Returns true iff that walk would see a second group-type prefix, a second
 * priority prefix, a second combine prefix, or any priority/combine prefix
 * positioned after a group-type prefix has already been seen — all hard
 * parse errors that suspend the whole plugin, not just skip one line.
 *
 * What this does NOT catch: anything outside this specific loop —
 * `ItemToHideExactNameWithExtRequired` (a bare `--%`/`/--hide:` group with
 * nothing after it — unreachable here anyway, since a bare reserved token is
 * already rejected by the `RESERVED_TOKENS` check in `encodeEntry` before a
 * line is ever built), wildcard (`...`) handling (already rejected earlier
 * in `encodeEntry`), or attribute/header-line misidentification (governed by
 * `ATTRIBUTE_LEXEMES` and unrelated to this loop, per the source). It is
 * also a static mirror of the *current* bundled parser: a future custom-sort
 * version that adds new prefix tokens would need this list updated too.
 *
 * In practice, given `RESERVED_TOKENS` is checked up front, this function
 * should never actually return true — the up-front check already excludes
 * every name whose first token could trigger it. It's kept as an
 * independent, from-scratch check on the literal line about to be emitted,
 * so a mistake in the token classification above (or a future edit to
 * `needsTypePrefix`) can't silently reintroduce the bug this file fixes.
 */
function misparsesAsMultipleGroupPrefixes(line: string): boolean {
	let rest = line;
	let groupTypeSeen = false;
	let groupTypeCount = 0;
	let priorityCount = 0;
	let combineCount = 0;

	for (;;) {
		let matched = false;

		for (const token of PRIORITY_PREFIX_TOKENS) {
			if (rest === token || rest.startsWith(`${token} `)) {
				if (groupTypeSeen) return true; // PriorityPrefixAfterGroupTypePrefix
				priorityCount++;
				if (priorityCount > 1) return true; // TooManyPriorityPrefixes
				rest = rest.slice(token.length).trim();
				matched = true;
				break;
			}
		}
		if (matched) continue;

		for (const token of COMBINE_PREFIX_TOKENS) {
			if (rest === token || rest.startsWith(`${token} `)) {
				if (groupTypeSeen) return true; // CombinePrefixAfterGroupTypePrefix
				combineCount++;
				if (combineCount > 1) return true; // TooManyCombinePrefixes
				rest = rest.slice(token.length).trim();
				matched = true;
				break;
			}
		}
		if (matched) continue;

		for (const token of GROUP_TYPE_PREFIX_TOKENS) {
			if (rest === token || rest.startsWith(`${token} `)) {
				groupTypeSeen = true;
				groupTypeCount++;
				if (groupTypeCount > 1) return true; // TooManyGroupTypePrefixes
				rest = rest.slice(token.length).trim();
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
}

function needsTypePrefix(entry: Entry, index: NameIndex): boolean {
	const name = entry.name;

	// 1. A folder and a file in this folder share the name.
	const kinds = index.get(name);
	if (kinds !== undefined && kinds.size > 1) return true;

	// 2a. Starts with one of our own attribute lexemes, case-sensitively.
	for (const lexeme of ATTRIBUTE_LEXEMES) {
		if (name.startsWith(lexeme)) return true;
	}

	// 2b. Case-insensitively starts with one of the 13 lexemes custom-sort's
	// own line-attribute matchers key on (see LINE_ATTRIBUTE_LEXEMES for the
	// full derivation and why case-insensitive startsWith is the right — and
	// only necessary — test). Lowercase once, not per lexeme: this loop runs
	// per sibling entry per save, and re-lowercasing `name` 13 times each call
	// would be pure waste.
	const lowerName = name.toLowerCase();
	for (const lexeme of LINE_ATTRIBUTE_LEXEMES) {
		if (lowerName.startsWith(lexeme)) return true;
	}

	// 3. Conservative catch-all.
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

	// A leading group-type/priority/combine prefix token can never be
	// neutralized by our own `/folders `/`/:files ` prefix: prefixing just
	// gives custom-sort's parser a second one to find, which is a hard parse
	// error that suspends the whole plugin (see `misparsesAsMultipleGroupPrefixes`
	// and the token lists above for exactly why). Nothing rescues this —
	// skip the entry rather than guess.
	const firstToken = name.split(/\s/)[0] ?? '';
	if (RESERVED_TOKENS.has(firstToken)) return { ok: false, reason: 'reserved-token' };

	// A name starting with one of GROUP_BODY_LEXEMES is equally unrescuable,
	// for a different reason: custom-sort's `startsWith` check there runs
	// against the group body itself (see the comment on that constant), so
	// our prefix never even gets a chance to be misinterpreted — it's simply
	// invisible to this check. Checked with `startsWith`, not "first
	// whitespace-delimited token", to mirror custom-sort's own `i.startsWith(...)`
	// exactly: `with-metadata:x` (no space before more text) still matches,
	// while `with-metadataFOO` (no colon) does not. Ordered after the
	// `RESERVED_TOKENS` check above only so the diagnostic reason a caller
	// sees is deterministic; the two sets don't overlap (none of these three
	// lexemes is itself a reserved token).
	for (const lexeme of GROUP_BODY_LEXEMES) {
		if (name.startsWith(lexeme)) return { ok: false, reason: 'group-attribute' };
	}

	const line = needsTypePrefix(entry, index)
		? `${entry.kind === 'folder' ? '/folders ' : '/:files '}${name}`
		: name;

	// Final whole-line sanity check on exactly what we are about to emit,
	// independent of the token-classification reasoning above.
	if (misparsesAsMultipleGroupPrefixes(line)) return { ok: false, reason: 'reserved-token' };

	return { ok: true, line };
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

/**
 * Whether `spec` has a section *authored by us* (bearing `AUTHORED_MARKER`)
 * whose target set resolves to `targetRaw`. Used to gate automated,
 * unattended rewrites (e.g. syncing the "hide sortspec.md" setting across
 * the whole vault) so they only ever touch a folder this plugin already has
 * a section for — never a folder whose sortspec.md is entirely hand-written,
 * and never a folder with no section at all. Matches on any section
 * (single- or multi-target) the same way `findMatches` does, not just
 * single-target ones: a multi-target match is still "authored" if the
 * marker is present, even though `upsertFolderOrder` itself would then
 * refuse to touch it (multi-target conflict) — that refusal is a separate,
 * later check, not this function's job.
 */
export function hasAuthoredSection(spec: ParsedSpec, targetRaw: string): boolean {
	const target = normalizeTarget(targetRaw.trim(), spec.specFolder);
	return findMatches(spec, target.resolved).some((m) => m.section.authored);
}

/**
 * `hideNames`: exact on-disk names (with extension, if any — the same string
 * custom-sort's own `t.children` names, not `Entry.name`) to emit as
 * `/--hide: <name>` lines in the authored section, so custom-sort filters
 * them out of this folder's rendering entirely. Currently only ever used for
 * `sortspec.md` itself, gated by the "hide sortspec.md" setting. Order among
 * `hideNames` is preserved; they're written before the entry lines.
 */
export function upsertFolderOrder(
	spec: ParsedSpec,
	targetRaw: string,
	entries: readonly Entry[],
	hideNames: readonly string[] = [],
): MutationResult {
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
	const encodedLines: string[] = hideNames.map((name) => `/--hide: ${name}`);
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

// ---------------------------------------------------------------------------
// Decoding: the inverse of encodeEntry, for restoring a previously-saved
// order when the modal reopens.
// ---------------------------------------------------------------------------

/** Aliases custom-sort accepts for the two type prefixes `encodeEntry` writes. */
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
 * `with-icon:`, ... — shares `ATTRIBUTE_LEXEMES` with `encodeEntry` so the
 * two stay in lockstep), bare catch-all tokens (`%`, `/%`, `/folders:files`,
 * a bare `/:files`, a bare `/folders`, ... — shares `RESERVED_TOKENS`),
 * anything indented (belongs to a custom-sort group, not this folder's own
 * list), and anything containing `...` (wildcard, unevaluable, and never
 * something `encodeEntry` would have written).
 *
 * Known asymmetry, left as-is: matching here is case-sensitive (`ATTRIBUTE_LEXEMES`,
 * checked with plain `startsWith`), while `needsTypePrefix` additionally
 * treats a case-insensitive prefix match against `LINE_ATTRIBUTE_LEXEMES` as
 * needing a type prefix on the *write* side (see that constant's comment).
 * That's fine for round-tripping our own output: everything `encodeEntry`
 * writes for a name in that danger zone is prefixed, so this function never
 * needs to recognize the bare, unprefixed, differently-cased form — the
 * prefix is what it actually sees, and `FOLDER_PREFIXES`/`FILE_PREFIXES`
 * strip it same as any other prefixed line. Making this function
 * case-insensitive too would be a *different* change: it would alter how a
 * foreign, hand-written line gets classified (e.g. a hand-authored `Desc
 * something` line, never touched by `encodeEntry`, would newly decode as
 * `null` instead of a literal name), which is not something this fix
 * touches.
 *
 * And it is not a latent bug either — traced, not assumed. Misclassifying a
 * foreign attribute line as a name yields a *phantom* entry in
 * `readFolderOrder`'s result, and every one of its three callers
 * (`OrderModal.onOpen`, `syncHideSetting`, `orderSync`'s rename and
 * reconcile paths) immediately passes that result through `mergeStoredOrder`
 * against the folder's live children, which drops any entry no file or folder
 * actually has that name. So a phantom can never reach a write. The foreign
 * attribute line itself is lost either way, because replacing a foreign
 * section rebuilds its body from scratch — that is pre-existing, deliberate,
 * and already reported to the user as "Replaced a hand-written section".
 * Don't "fix" this without first finding a caller that skips
 * `mergeStoredOrder`.
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
 * Reads back the order stored for `targetRaw`, the read-side counterpart to
 * `upsertFolderOrder`. Finds the section whose target set is exactly this
 * one resolved target — reusing `findMatches`, the same matching rule
 * `upsertFolderOrder` uses — and decodes its body in order.
 *
 * `siblings` is the folder's actual current children (e.g. from
 * `entriesFor`). It resolves the one thing `decodeEntryLine` can't on its
 * own: a bare, unprefixed line. `encodeEntry` only omits the type prefix
 * when the name doesn't collide with a same-named sibling of the other kind
 * — so if exactly one kind of `siblings` entry has this name, that must be
 * the kind that was written. This is why `readFolderOrder` takes a third
 * `siblings` parameter instead of the two-arg form: without live sibling
 * context, nothing in the text of a bare line distinguishes a folder named
 * "Foo" from a file named "Foo", so the two-arg form cannot satisfy the
 * round-trip property (`readFolderOrder(upsertFolderOrder(...).spec, T) ===
 * entries`) for arbitrary entries.
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

// ---------------------------------------------------------------------------
// Restoring a modal's row order: reconcile a previously-saved order against
// the folder's actual current children.
// ---------------------------------------------------------------------------

function entryKey(entry: Entry): string {
	return `${entry.kind}\u0000${entry.name}`;
}

/**
 * Reconciles a previously-saved order (`stored`, typically from
 * `readFolderOrder`, or `null` if there was none) against the folder's
 * actual current children (`siblings`, in the fallback order — see
 * `entriesFor`).
 *
 * Stored entries that still exist keep their stored positions, in order.
 * Children not mentioned in the stored order are appended afterwards in the
 * fallback order. Stored entries whose files/folders no longer exist are
 * dropped. Without this, reopening the modal on an already-ordered folder
 * would show alphabetical order, and saving would silently destroy the
 * existing order.
 */
export function mergeStoredOrder(stored: readonly Entry[] | null, siblings: readonly Entry[]): Entry[] {
	if (stored === null) return [...siblings];

	const siblingByKey = new Map(siblings.map((entry) => [entryKey(entry), entry] as const));
	const seen = new Set<string>();
	const merged: Entry[] = [];

	for (const storedEntry of stored) {
		const key = entryKey(storedEntry);
		if (seen.has(key)) continue; // defensive: ignore a duplicate within the stored order itself
		const live = siblingByKey.get(key);
		if (live === undefined) continue; // no longer exists -> dropped
		seen.add(key);
		merged.push(live);
	}
	for (const sibling of siblings) {
		const key = entryKey(sibling);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(sibling);
	}
	return merged;
}

/**
 * In-place-position rename: swaps `from` for `to` wherever `from` sits in
 * `order`, without disturbing anything else's position. This is what
 * `mergeStoredOrder` alone cannot do — it matches purely on (kind, name), so
 * a renamed file looks to it like two unrelated entries: the old name it can
 * no longer find among live siblings (dropped) and the new name it's never
 * heard of (appended at the end). Feeding `renameEntryInOrder`'s result into
 * `mergeStoredOrder` instead is what lets a rename preserve position; the
 * companion "combined with mergeStoredOrder" test in orderMerge.test.ts pins
 * exactly this, with a plain merge as the control showing the drop-to-end
 * defect this function exists to avoid.
 *
 * Returns `null` when `from` isn't in `order` at all (matched by exact
 * (kind, name), same identity rule as `mergeStoredOrder`'s `entryKey`) — the
 * caller's signal to skip writing anything, rather than rewrite a section
 * with no actual change. This also makes the function naturally idempotent:
 * apply it once and `from` is gone from the order (replaced by `to`), so
 * applying the "same" rename again finds nothing to do and returns `null`.
 *
 * If `to` already occurs elsewhere in `order` (e.g. a file was renamed to a
 * name matching some other stale entry that's still listed), that other
 * occurrence is deleted rather than left as a duplicate — the position `to`
 * ends up at is the one `from` occupied, not the one the pre-existing
 * duplicate occupied. Duplicates aren't something `upsertFolderOrder` would
 * ever have written itself, but nothing stops a stored order from
 * accumulating one across enough renames if this weren't deduped here.
 */
export function renameEntryInOrder(order: readonly Entry[], from: Entry, to: Entry): readonly Entry[] | null {
	const fromKey = entryKey(from);
	const fromIndex = order.findIndex((entry) => entryKey(entry) === fromKey);
	if (fromIndex === -1) return null;

	const toKey = entryKey(to);
	const result: Entry[] = [];
	order.forEach((entry, index) => {
		if (index === fromIndex) {
			result.push(to);
			return;
		}
		if (entryKey(entry) === toKey) return; // pre-existing duplicate of `to` elsewhere: drop it, keep the renamed slot's position
		result.push(entry);
	});
	return result;
}
