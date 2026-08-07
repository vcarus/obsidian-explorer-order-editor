import { describe, expect, it } from 'vitest';
import {
	buildNameIndex,
	canonicalizeSortingSpec,
	encodeEntry,
	hasAuthoredSection,
	normalizeTarget,
	parseSortingSpec,
	readFolderOrder,
	removeFolderOrder,
	serializeSortingSpec,
	specTargets,
	upsertFolderOrder,
	type EncodeEntryResult,
	type NameIndex,
} from '../src/sortspec';
import type { Entry } from '../src/types';

const file = (name: string): Entry => ({ name, kind: 'file' });
const folder = (name: string): Entry => ({ name, kind: 'folder' });
const emptyIndex: NameIndex = buildNameIndex([]);

// ---------------------------------------------------------------------------
// normalizeTarget / target kinds
// ---------------------------------------------------------------------------

describe('normalizeTarget', () => {
	it('classifies root, dot (resolved and unresolved), wildcard, dead, path, and empty', () => {
		expect(normalizeTarget('/', null)).toEqual({ kind: 'root', raw: '/', resolved: '/' });
		expect(normalizeTarget('.', 'Archive/Sub')).toEqual({ kind: 'dot', raw: '.', resolved: 'Archive/Sub' });
		expect(normalizeTarget('.', null)).toEqual({ kind: 'dot', raw: '.', resolved: null });
		expect(normalizeTarget('Foo/.../Bar', null)).toEqual({ kind: 'wildcard', raw: 'Foo/.../Bar', resolved: null });
		expect(normalizeTarget('/Projects', null)).toEqual({ kind: 'dead', raw: '/Projects', resolved: null });
		expect(normalizeTarget('Archive/Sub/', null)).toEqual({ kind: 'path', raw: 'Archive/Sub/', resolved: 'Archive/Sub' });
		expect(normalizeTarget('', null)).toEqual({ kind: 'empty', raw: '', resolved: null });
	});

	it('matching is case-sensitive', () => {
		expect(normalizeTarget('Archive', null).resolved).not.toBe(normalizeTarget('archive', null).resolved);
	});
});

// ---------------------------------------------------------------------------
// parseSortingSpec / serializeSortingSpec — structure
// ---------------------------------------------------------------------------

describe('parseSortingSpec section splitting', () => {
	it('a target-folder line at indentation 0 starts a section', () => {
		const spec = parseSortingSpec('target-folder: Archive\nItem1\nItem2');
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.targets).toHaveLength(1);
		expect(spec.sections[0]?.rawLines).toEqual(['target-folder: Archive', 'Item1', 'Item2']);
	});

	it('consecutive target lines (blanks/comments notwithstanding) merge into one multi-target section', () => {
		const spec = parseSortingSpec('target-folder: A\n\n// note\ntarget-folder: B\nItem');
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.targets.map((t) => t.raw)).toEqual(['A', 'B']);
	});

	it('a target line after an instruction line starts a new section', () => {
		const spec = parseSortingSpec('target-folder: A\nItem1\ntarget-folder: B\nItem2');
		expect(spec.sections).toHaveLength(2);
	});

	it('blank lines and // comments are inert and never delimit', () => {
		const spec = parseSortingSpec('target-folder: A\n\n// comment\nItem1\n\nItem2');
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.rawLines).toEqual(['target-folder: A', '', '// comment', 'Item1', '', 'Item2']);
	});

	it('an indented target-folder line is a body line, not a header', () => {
		const spec = parseSortingSpec('target-folder: A\n  target-folder: B\nItem');
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.targets).toHaveLength(1);
	});

	it('"::::" is a synonym for target-folder:', () => {
		const spec = parseSortingSpec(':::: Archive\nItem');
		expect(spec.sections[0]?.targets[0]).toMatchObject({ raw: 'Archive', kind: 'path' });
	});

	it('lines before the first target header form the prologue, preserved verbatim', () => {
		const spec = parseSortingSpec('// leading comment\n\ntarget-folder: A\nItem');
		expect(spec.prologue).toEqual(['// leading comment', '']);
	});

	it('the authored marker is detected only immediately after the (last) target line, never before', () => {
		expect(parseSortingSpec('target-folder: .\n// explorer-order-editor\nItem').sections[0]?.authored).toBe(true);
		expect(parseSortingSpec('target-folder: .\n// something else\nItem').sections[0]?.authored).toBe(false);
		const beforeCase = parseSortingSpec('// explorer-order-editor\ntarget-folder: .\nItem');
		expect(beforeCase.prologue).toEqual(['// explorer-order-editor']);
		expect(beforeCase.sections[0]?.authored).toBe(false);
	});

	it('parses/serializes an entirely empty value to an empty spec/string', () => {
		const spec = parseSortingSpec('');
		expect(spec).toEqual({ prologue: [], sections: [], specFolder: null });
		expect(serializeSortingSpec(spec)).toBe('');
	});
});

describe('canonical-value invariant', () => {
	it('normalizes CRLF/CR to LF and drops only trailing blank lines', () => {
		expect(canonicalizeSortingSpec('a\r\nb\rc')).toBe('a\nb\nc');
		expect(canonicalizeSortingSpec('a\n\nb\n\n\n')).toBe('a\n\nb');
		expect(canonicalizeSortingSpec('a\nb\n')).toBe('a\nb');
	});
});

describe('round trip: serialize(parse(x)) === canonicalize(x)', () => {
	const corpus: readonly string[] = [
		'target-folder: /\n// explorer-order-editor\nA\nB',
		'target-folder: .\n\n\ninterior blank preserved\n\n\ntrailing blanks dropped\n\n\n',
		'  target-folder: not a header\ntarget-folder: /\nreal item',
		'target-folder: A\ntarget-folder: B\n// shared\nItem',
		'target-folder: A\r\nItem\r\ntarget-folder: B\r\nItem2\r\n',
		'no target header at all, just stray text\nmore stray text',
	];

	it.each(corpus.map((c, i) => [i, c] as const))('corpus[%i]', (_i, source) => {
		expect(serializeSortingSpec(parseSortingSpec(source, '/'))).toBe(canonicalizeSortingSpec(source));
	});
});

// ---------------------------------------------------------------------------
// encodeEntry / buildNameIndex
// ---------------------------------------------------------------------------

describe('buildNameIndex + encodeEntry: folder/file name collision', () => {
	it('a folder and a file sharing a name both get a disambiguating prefix', () => {
		const idx = buildNameIndex([file('Notes'), folder('Notes')]);
		expect(encodeEntry(file('Notes'), idx)).toEqual({ ok: true, line: '/:files Notes' });
		expect(encodeEntry(folder('Notes'), idx)).toEqual({ ok: true, line: '/folders Notes' });
	});

	it('no collision -> bare name', () => {
		const idx = buildNameIndex([file('Notes'), folder('Other')]);
		expect(encodeEntry(file('Notes'), idx)).toEqual({ ok: true, line: 'Notes' });
	});
});

// One table covering every reserved token, every unrepresentable reason, plus
// a few representative attribute-lexeme / catch-all rows.
const RESERVED_TOKENS = [
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
] as const;

interface EncodeCase {
	readonly label: string;
	readonly name: string;
	readonly expected: EncodeEntryResult;
}

// Every one of these 17 tokens, when it is the *entire* first
// space-delimited word of a name, cannot be rescued by our own
// `/folders `/`/:files ` prefix: custom-sort's `parseSortingGroupSpec`
// recognizes the injected prefix as one group-type token, then recognizes
// the name's own leading token as a second one (or, for the 4
// priority/combine tokens, as one positioned illegally *after* a group-type
// token) — a hard parse error that suspends the whole plugin. Verified by
// tracing custom-sort's bundled `main.js` line by line for each token (see
// `misparsesAsMultipleGroupPrefixes` in `src/sortspec.ts` for the mirrored
// logic). This replaces what used to be the buggy expectation here: every
// one of these previously expected `{ ok: true, line: '/:files ' + token }`,
// which is exactly the shape of the reported bug (`/:files --% hidden`).
const reservedTokenCases: EncodeCase[] = RESERVED_TOKENS.map((token) => ({
	label: `reserved token ${JSON.stringify(token)} (whole name)`,
	name: token,
	expected: { ok: false, reason: 'reserved-token' },
}));

const otherCases: EncodeCase[] = [
	// Regression test for the exact reported bug: a file named "--% hidden"
	// must be unrepresentable, never emitted as "/:files --% hidden" (which
	// custom-sort rejects with "TooManyGroupTypePrefixes" and suspends).
	{ label: 'regression: the exact reported bug ("--% hidden")', name: '--% hidden', expected: { ok: false, reason: 'reserved-token' } },
	{ label: 'reserved token as first space-delimited token, with more text after', name: '/folders rest of name', expected: { ok: false, reason: 'reserved-token' } },
	{ label: 'catch-all "%" as a real leading word, not just a leading character', name: '% catch all', expected: { ok: false, reason: 'reserved-token' } },
	{
		label: 'priority prefix "/!" as a leading word (would trigger PriorityPrefixAfterGroupTypePrefix if prefixed)',
		name: '/! rest',
		expected: { ok: false, reason: 'reserved-token' },
	},
	{
		label: 'combine prefix "/+" as a leading word (would trigger CombinePrefixAfterGroupTypePrefix if prefixed)',
		name: '/+ rest',
		expected: { ok: false, reason: 'reserved-token' },
	},
	{ label: 'attribute lexeme target-folder:', name: 'target-folder: x', expected: { ok: true, line: '/:files target-folder: x' } },
	{ label: 'attribute lexeme ::::', name: '::::x', expected: { ok: true, line: '/:files ::::x' } },
	{ label: 'attribute lexeme <', name: '<x', expected: { ok: true, line: '/:files <x' } },
	// with-metadata:/bookmarked:/with-icon: are NOT safe to prefix, unlike the
	// other attribute lexemes below — see the GROUP_BODY_LEXEMES describe
	// block for the dedicated coverage of why. This case used to assert the
	// buggy `{ ok: true, line: '/:files with-metadata: x' }` expectation.
	{ label: 'catch-all %Report', name: '%Report', expected: { ok: true, line: '/:files %Report' } },
	{ label: 'catch-all //comment shape', name: '//comment', expected: { ok: true, line: '/:files //comment' } },
	{ label: 'catch-all --double-dash', name: '--x', expected: { ok: true, line: '/:files --x' } },
	{ label: 'reserved token stuck to more text with no space boundary is safe', name: '/foldersXYZ', expected: { ok: true, line: '/:files /foldersXYZ' } },
	{ label: 'ordinary name, no prefix needed', name: 'Meeting notes', expected: { ok: true, line: 'Meeting notes' } },
	{ label: 'unrepresentable: empty', name: '', expected: { ok: false, reason: 'empty' } },
	{ label: 'unrepresentable: whitespace (leading)', name: ' Foo', expected: { ok: false, reason: 'whitespace' } },
	{ label: 'unrepresentable: whitespace (only)', name: '   ', expected: { ok: false, reason: 'whitespace' } },
	{ label: 'unrepresentable: newline', name: 'Foo\nBar', expected: { ok: false, reason: 'newline' } },
	{ label: 'unrepresentable: carriage return', name: 'Foo\rBar', expected: { ok: false, reason: 'newline' } },
	{ label: 'unrepresentable: wildcard', name: 'a...b', expected: { ok: false, reason: 'wildcard' } },
	{ label: 'unrepresentable: backslash', name: 'a\\b', expected: { ok: false, reason: 'backslash' } },
	{ label: 'evaluation order: "\\<x" is backslash, not the "<" lexeme', name: '\\<x', expected: { ok: false, reason: 'backslash' } },
	{ label: 'evaluation order: wildcard beats backslash when both present', name: 'a...\\b', expected: { ok: false, reason: 'wildcard' } },
];

describe.each([...reservedTokenCases, ...otherCases])('encodeEntry: $label', ({ name, expected }) => {
	it('matches the expected result', () => {
		expect(encodeEntry(file(name), emptyIndex)).toEqual(expected);
	});
});

describe('encodeEntry: reserved-token reason applies regardless of entry kind', () => {
	it.each(['--% hidden', '%', '/folders', '/!', '/+'])('%s: file and folder both unrepresentable', (name) => {
		expect(encodeEntry(file(name), emptyIndex)).toEqual({ ok: false, reason: 'reserved-token' });
		expect(encodeEntry(folder(name), emptyIndex)).toEqual({ ok: false, reason: 'reserved-token' });
	});
});

describe('upsertFolderOrder never emits the buggy "/:files --% hidden" line for the reported case', () => {
	it('skips the entry with a reserved-token diagnostic instead', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('--% hidden')]);
		expect(result.diagnostics).toEqual([{ kind: 'unrepresentable-entry', name: '--% hidden', reason: 'reserved-token' }]);
		expect(serializeSortingSpec(result.spec)).not.toContain('--% hidden');
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor');
	});
});

// GROUP_BODY_LEXEMES ('with-metadata:', 'bookmarked:', 'with-icon:') regression
// coverage. Unlike the rest of ATTRIBUTE_LEXEMES, custom-sort's `startsWith`
// check for these three runs against the *group body*, i.e. exactly the text
// our own prefix leaves behind — so, unlike `target-folder:`/`order-desc:`/`<`
// above, prefixing does not help at all. See the comment on
// GROUP_BODY_LEXEMES in src/sortspec.ts for the full mechanism, traced from
// custom-sort's bundled source.
describe('encodeEntry: GROUP_BODY_LEXEMES — prefixing cannot rescue these', () => {
	it.each(['with-metadata:', 'bookmarked:', 'with-icon:'])('%s alone is rejected as group-attribute', (lexeme) => {
		expect(encodeEntry(file(`${lexeme} x`), emptyIndex)).toEqual({ ok: false, reason: 'group-attribute' });
	});

	it.each(['with-metadata:', 'bookmarked:', 'with-icon:'])(
		'%s is rejected for a folder too, regardless of entry kind',
		(lexeme) => {
			expect(encodeEntry(folder(`${lexeme} x`), emptyIndex)).toEqual({ ok: false, reason: 'group-attribute' });
		},
	);

	// The core of the defect: a same-named sibling of the other kind is
	// exactly the situation that would otherwise force `needsTypePrefix` to
	// add the `/folders `/`/:files ` prefix — and that prefix is precisely
	// what does NOT save these three names. Confirms the rejection happens
	// before prefixing is even considered, not that prefixing merely "isn't
	// needed" for these.
	it.each(['with-metadata:', 'bookmarked:', 'with-icon:'])(
		'%s is still rejected even with a same-named sibling of the other kind',
		(lexeme) => {
			const name = `${lexeme} x`;
			const idx = buildNameIndex([file(name), folder(name)]);
			expect(encodeEntry(file(name), idx)).toEqual({ ok: false, reason: 'group-attribute' });
			expect(encodeEntry(folder(name), idx)).toEqual({ ok: false, reason: 'group-attribute' });
		},
	);

	it('matches custom-sort\'s own startsWith, not "first space-delimited word"', () => {
		// No space before more text: custom-sort's `i.startsWith("with-metadata:")`
		// still matches "with-metadata:x", so this must still be rejected.
		expect(encodeEntry(file('with-metadata:x'), emptyIndex)).toEqual({ ok: false, reason: 'group-attribute' });
	});

	it('a name merely starting with the same letters but missing the lexeme is safe', () => {
		expect(encodeEntry(file('with-metadataFOO'), emptyIndex)).toEqual({ ok: true, line: 'with-metadataFOO' });
		expect(encodeEntry(file('bookmarkedX'), emptyIndex)).toEqual({ ok: true, line: 'bookmarkedX' });
	});
});

// Control group: these three names are confirmed working today in testvault
// with the injected `/:files ` prefix (custom-sort recognizes them as
// line-level attributes *before* group-body parsing, so the prefix routes
// them safely into a literal-name match). Regressing any of these back to
// "unrepresentable" would be a new bug introduced by this change, not a fix.
describe('encodeEntry: attribute lexemes outside GROUP_BODY_LEXEMES remain safe to prefix', () => {
	it('order-desc: a-z', () => {
		expect(encodeEntry(file('order-desc: a-z'), emptyIndex)).toEqual({ ok: true, line: '/:files order-desc: a-z' });
	});

	it('target-folder: evil', () => {
		expect(encodeEntry(file('target-folder: evil'), emptyIndex)).toEqual({ ok: true, line: '/:files target-folder: evil' });
	});

	it('<img src=x onerror=alert(1)>', () => {
		expect(encodeEntry(file('<img src=x onerror=alert(1)>'), emptyIndex)).toEqual({
			ok: true,
			line: '/:files <img src=x onerror=alert(1)>',
		});
	});
});

// ---------------------------------------------------------------------------
// LINE_ATTRIBUTE_LEXEMES — mirrors custom-sort's own `ro` line-attribute map.
// A bare, unprefixed line whose text (lowercased) starts with one of these 13
// keys is misread as an attribute line before custom-sort ever gets to group
// parsing -- see LINE_ATTRIBUTE_LEXEMES in src/sortspec.ts for the full
// mechanism, traced from the bundled source. Unlike GROUP_BODY_LEXEMES,
// prefixing genuinely rescues every one of these; none belongs in
// UnencodableReason.
// ---------------------------------------------------------------------------

// The 13 keys transcribed directly from custom-sort's bundled `ro` object,
// each tried here as a literal name. Some are tested bare, some with " x"
// appended so the case reads as a plausible real name (nobody names a file
// literally "sorting:", but "sorting: my notes" is the same hazard). The two
// backslash keys ("\<", "\>") can never actually reach needsTypePrefix --
// `encodeEntry` rejects any name containing "\" with reason 'backslash'
// first -- so they get their own assertion below instead of a "gets
// prefixed" expectation.
const roKeyCases: EncodeCase[] = [
	{ label: 'ro key "<"', name: '<x', expected: { ok: true, line: '/:files <x' } },
	{ label: 'ro key ">"', name: '>x', expected: { ok: true, line: '/:files >x' } },
	{ label: 'ro key "order-asc:"', name: 'order-asc: x', expected: { ok: true, line: '/:files order-asc: x' } },
	{ label: 'ro key "order-desc:"', name: 'order-desc: x', expected: { ok: true, line: '/:files order-desc: x' } },
	{ label: 'ro key "sorting:"', name: 'sorting: x', expected: { ok: true, line: '/:files sorting: x' } },
	{ label: 'ro key "order-asc" (no colon)', name: 'order-asc x', expected: { ok: true, line: '/:files order-asc x' } },
	{ label: 'ro key "order-desc" (no colon)', name: 'order-desc x', expected: { ok: true, line: '/:files order-desc x' } },
	{ label: 'ro key "asc" (no colon)', name: 'asc x', expected: { ok: true, line: '/:files asc x' } },
	{ label: 'ro key "desc" (no colon)', name: 'desc x', expected: { ok: true, line: '/:files desc x' } },
	{ label: 'ro key "target-folder:"', name: 'target-folder: x', expected: { ok: true, line: '/:files target-folder: x' } },
	{ label: 'ro key "::::"', name: ':::: x', expected: { ok: true, line: '/:files :::: x' } },
];

describe.each(roKeyCases)('encodeEntry: $label', ({ name, expected }) => {
	it('gets the disambiguating prefix', () => {
		expect(encodeEntry(file(name), emptyIndex)).toEqual(expected);
	});
});

describe('encodeEntry: the two backslash ro keys ("\\<", "\\>") never reach needsTypePrefix at all', () => {
	it.each(['\\<x', '\\>x'])('%s is rejected as backslash, not prefixed', (name) => {
		expect(encodeEntry(file(name), emptyIndex)).toEqual({ ok: false, reason: 'backslash' });
	});
});

describe('encodeEntry: LINE_ATTRIBUTE_LEXEMES kind-aware prefix', () => {
	it('a folder gets /folders, not /:files', () => {
		expect(encodeEntry(folder('desc x'), emptyIndex)).toEqual({ ok: true, line: '/folders desc x' });
	});
});

describe('encodeEntry: LINE_ATTRIBUTE_LEXEMES matching is case-insensitive (this is the bug being fixed)', () => {
	it.each([
		['Desc x', '/:files Desc x'],
		['DESC x', '/:files DESC x'],
		['Order-Desc: x', '/:files Order-Desc: x'],
		['SORTING: x', '/:files SORTING: x'],
		['Target-Folder: x', '/:files Target-Folder: x'],
	])('%s gets prefixed', (name, line) => {
		expect(encodeEntry(file(name), emptyIndex)).toEqual({ ok: true, line });
	});
});

// The most dangerous face of this bug: checkForRiskyAttrSyntaxError matches
// by *prefix*, not whole word, so completely ordinary file names that merely
// start with the same letters as a ro key were being written bare and then
// misread by custom-sort as attribute lines. "desc" (no trailing space at
// all) is included because checkForRiskyAttrSyntaxError never requires a
// space after the match -- only parseAttribute does, and parseAttribute
// isn't the relevant check here (see LINE_ATTRIBUTE_LEXEMES's comment on why
// the union of the two collapses to a plain prefix test).
describe('encodeEntry: LINE_ATTRIBUTE_LEXEMES matches by prefix, not whole word -- ordinary names collide', () => {
	it.each(['description', 'descent', 'ascending notes', 'Ascii art', 'describe', 'desc', 'sorting: x'])(
		'%s gets the disambiguating prefix even though it is an ordinary name, not an attribute',
		(name) => {
			expect(encodeEntry(file(name), emptyIndex)).toEqual({ ok: true, line: `/:files ${name}` });
		},
	);
});

// Names that merely resemble a ro key (same starting letters, wrong length,
// or diverge before the key ends) must NOT be over-prefixed -- that would be
// its own regression (unnecessary noise in every affected user's sortspec.md).
describe('encodeEntry: names that only resemble a ro key stay bare, unprefixed', () => {
	it.each(['ordering', 'note', 'as', 'de', 'sort notes', 'Foo', 'Bar'])('%s stays a bare line', (name) => {
		expect(encodeEntry(file(name), emptyIndex)).toEqual({ ok: true, line: name });
	});
});

describe('upsertFolderOrder: LINE_ATTRIBUTE_LEXEMES-colliding names save cleanly, prefixed, with no diagnostics', () => {
	it('a mixed batch round-trips through a save with zero diagnostics', () => {
		const entries = [file('desc x'), file('Ascii art'), folder('order-desc x'), file('description')];
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(result.diagnostics).toEqual([]);
		expect(serializeSortingSpec(result.spec)).toBe(
			[
				'target-folder: .',
				'// explorer-order-editor',
				'/:files desc x',
				'/:files Ascii art',
				'/folders order-desc x',
				'/:files description',
			].join('\n'),
		);
	});
});

describe('upsertFolderOrder: GROUP_BODY_LEXEMES names are skipped with a diagnostic, not written', () => {
	it('produces an unrepresentable-entry diagnostic with reason group-attribute and omits the line', () => {
		const entries = [file('Good1'), file('with-metadata: x'), folder('bookmarked: y'), file('Good2')];
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(result.status).toBe('appended');
		expect(result.diagnostics).toEqual([
			{ kind: 'unrepresentable-entry', name: 'with-metadata: x', reason: 'group-attribute' },
			{ kind: 'unrepresentable-entry', name: 'bookmarked: y', reason: 'group-attribute' },
		]);
		const serialized = serializeSortingSpec(result.spec);
		expect(serialized).toBe('target-folder: .\n// explorer-order-editor\nGood1\nGood2');
		expect(serialized).not.toContain('with-metadata');
		expect(serialized).not.toContain('bookmarked');
	});
});

describe('self-heal: a previously-written GROUP_BODY_LEXEMES line is read back, then dropped on the next save', () => {
	it('readFolderOrder still decodes the pre-existing bad line (parseEntryLine is unchanged) ...', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nGood1\n/:files with-metadata: x', '/');
		const decoded = readFolderOrder(spec, '.', [file('Good1'), file('with-metadata: x')]);
		expect(decoded).toEqual([file('Good1'), file('with-metadata: x')]);
	});

	it('... but the next upsertFolderOrder using that decoded order drops it, with a diagnostic, instead of re-writing it', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nGood1\n/:files with-metadata: x', '/');
		const decoded = readFolderOrder(spec, '.', [file('Good1'), file('with-metadata: x')]);
		if (decoded === null) throw new Error('expected a decoded order');
		const result = upsertFolderOrder(spec, '.', decoded);
		expect(result.status).toBe('replaced');
		expect(result.diagnostics).toEqual([{ kind: 'unrepresentable-entry', name: 'with-metadata: x', reason: 'group-attribute' }]);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\nGood1');
	});
});

describe('encodeEntry output re-parses as an instruction and survives trim()', () => {
	const representative = [
		// Not "/" or "/:files" bare — those are now unrepresentable (see
		// reservedTokenCases above). These exercise the same prefixed-line
		// re-parse property for names that merely *start* with reserved
		// punctuation, which is where prefixing genuinely applies.
		'/slash-first',
		'--dashes',
		'target-folder: x',
		'::::x',
		'<x',
		'%Report',
		'//comment',
		'Meeting notes',
		// LINE_ATTRIBUTE_LEXEMES coverage: a no-colon ro key ("desc") and a
		// case-insensitive match that ATTRIBUTE_LEXEMES alone wouldn't have
		// caught (see the dedicated describe blocks above for the full story).
		'desc x',
		'SORTING: x',
	];

	it.each(representative)('%s', (name) => {
		const result = encodeEntry(file(name), emptyIndex);
		if (!result.ok) throw new Error(`expected ${name} to be representable`);
		expect(result.line.trim()).toBe(result.line);
		const spec = parseSortingSpec(`target-folder: .\n// explorer-order-editor\n${result.line}`);
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.targets).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// upsertFolderOrder — conflict policy
// ---------------------------------------------------------------------------

describe('upsertFolderOrder: no match', () => {
	it('appends a new authored section with no blank-line separator, sharing prior sections by reference', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\nOld', '/');
		const result = upsertFolderOrder(spec, '.', [file('A'), file('B')]);
		expect(result.status).toBe('appended');
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: Elsewhere\nOld\ntarget-folder: .\n// explorer-order-editor\nA\nB');
		expect(result.spec.sections[0]).toBe(spec.sections[0]);
	});

	it('appends with an empty body when there are no entries', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', []);
		expect(result.status).toBe('appended');
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor');
	});
});

describe('upsertFolderOrder: single foreign match', () => {
	it('replaces it in place (position preserved), warns, and leaves siblings untouched by reference', () => {
		const spec = parseSortingSpec('target-folder: Before\nX\n\ntarget-folder: .\nForeign entry\n\ntarget-folder: After\nY', '/');
		const result = upsertFolderOrder(spec, '.', [file('New')]);
		expect(result.status).toBe('replaced');
		expect(result.diagnostics).toContainEqual({ kind: 'foreign-section-replaced' });
		expect(result.spec.sections[0]).toBe(spec.sections[0]);
		expect(result.spec.sections[2]).toBe(spec.sections[2]);
		expect(result.spec.sections[1]?.rawLines).toEqual(['target-folder: .', '// explorer-order-editor', 'New']);
	});
});

describe('upsertFolderOrder: single authored match', () => {
	it('different content -> replaced, no foreign-section-replaced warning', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nOld', '/');
		const result = upsertFolderOrder(spec, '.', [file('New')]);
		expect(result.status).toBe('replaced');
		expect(result.diagnostics).toEqual([]);
	});

	it('identical content -> unchanged, same spec by identity (idempotency)', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nA\nB', '/');
		const result = upsertFolderOrder(spec, '.', [file('A'), file('B')]);
		expect(result.status).toBe('unchanged');
		expect(result.spec).toBe(spec);
	});

	it('running the identical upsert twice produces byte-identical output', () => {
		const spec = parseSortingSpec('target-folder: Foo\nBar', '/');
		const once = upsertFolderOrder(spec, '.', [file('A'), folder('B')]);
		const twice = upsertFolderOrder(once.spec, '.', [file('A'), folder('B')]);
		expect(twice.status).toBe('unchanged');
		expect(serializeSortingSpec(twice.spec)).toBe(serializeSortingSpec(once.spec));
	});
});

describe('upsertFolderOrder: multiple exact matches', () => {
	it('all authored by us -> keeps the last, deletes the earlier ones', () => {
		const spec = parseSortingSpec(
			['target-folder: .', '// explorer-order-editor', 'Old1', '', 'target-folder: .', '// explorer-order-editor', 'Old2'].join('\n'),
			'/',
		);
		const result = upsertFolderOrder(spec, '.', [file('New')]);
		expect(result.status).toBe('replaced');
		expect(result.spec.sections).toHaveLength(1);
		expect(result.spec.sections[0]?.rawLines).toEqual(['target-folder: .', '// explorer-order-editor', 'New']);
	});

	it('any foreign among duplicates -> blocked + duplicate-section with a count, spec unchanged by identity', () => {
		const spec = parseSortingSpec('target-folder: Archive\nForeign1\n\ntarget-folder: Archive\nForeign2', '/');
		const result = upsertFolderOrder(spec, 'Archive', [file('New')]);
		expect(result.status).toBe('blocked');
		expect(result.diagnostics).toEqual([{ kind: 'duplicate-section', count: 2 }]);
		expect(result.spec).toBe(spec);
	});
});

describe('upsertFolderOrder: multi-target conflict', () => {
	it('blocks the save and returns the input spec unchanged by identity', () => {
		const spec = parseSortingSpec('target-folder: Archive\ntarget-folder: Inbox\n// shared\nItem', '/');
		const result = upsertFolderOrder(spec, 'Archive', [file('New')]);
		expect(result.status).toBe('blocked');
		expect(result.spec).toBe(spec);
		expect(result.diagnostics).toEqual([{ kind: 'multi-target-conflict', targets: ['Archive', 'Inbox'] }]);
	});
});

describe('upsertFolderOrder: unrepresentable entries', () => {
	it('are skipped with a diagnostic, without blocking the rest of the save', () => {
		const entries = [file('Good1'), file('a...b'), file('Good2')];
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(result.status).toBe('appended');
		expect(result.diagnostics).toEqual([{ kind: 'unrepresentable-entry', name: 'a...b', reason: 'wildcard' }]);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\nGood1\nGood2');
	});

	it('several different unencodable reasons in one save are all skipped, and the rest still saves', () => {
		const entries = [file('Good1'), file(' leading space'), file('a...b'), file('back\\slash'), file('Good2'), file('')];
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(result.status).toBe('appended');
		expect(result.diagnostics).toEqual([
			{ kind: 'unrepresentable-entry', name: ' leading space', reason: 'whitespace' },
			{ kind: 'unrepresentable-entry', name: 'a...b', reason: 'wildcard' },
			{ kind: 'unrepresentable-entry', name: 'back\\slash', reason: 'backslash' },
			{ kind: 'unrepresentable-entry', name: '', reason: 'empty' },
		]);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\nGood1\nGood2');
	});
});

// ---------------------------------------------------------------------------
// upsertFolderOrder: hideNames (custom-sort's own `/--hide:` item-hide
// directive, emitted for the "hide sortspec.md" setting)
// ---------------------------------------------------------------------------

describe('upsertFolderOrder: hideNames', () => {
	it('emits one "/--hide: <name>" line per hidden name, right after the marker and before entries', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('A'), folder('B')], ['sortspec.md']);
		expect(result.status).toBe('appended');
		expect(serializeSortingSpec(result.spec)).toBe(
			'target-folder: .\n// explorer-order-editor\n/--hide: sortspec.md\nA\nB',
		);
	});

	it('supports multiple hidden names, in the given order', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', [], ['a.md', 'b.md']);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\n/--hide: a.md\n/--hide: b.md');
	});

	it('defaults to no hidden names when the parameter is omitted', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('A')]);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\nA');
	});

	it('running the identical upsert with the same hideNames twice is idempotent', () => {
		const once = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('A')], ['sortspec.md']);
		const twice = upsertFolderOrder(once.spec, '.', [file('A')], ['sortspec.md']);
		expect(twice.status).toBe('unchanged');
		expect(serializeSortingSpec(twice.spec)).toBe(serializeSortingSpec(once.spec));
	});

	it('turning hideNames on for an already-saved folder is a real change, not a no-op', () => {
		const withoutHide = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('A')]);
		const withHide = upsertFolderOrder(withoutHide.spec, '.', [file('A')], ['sortspec.md']);
		expect(withHide.status).toBe('replaced');
		expect(serializeSortingSpec(withHide.spec)).toContain('/--hide: sortspec.md');
	});
});

// ---------------------------------------------------------------------------
// specTargets
// ---------------------------------------------------------------------------

describe('specTargets', () => {
	it('true when a single-target section resolves to the key', () => {
		const spec = parseSortingSpec('target-folder: .\nItem', 'Archive');
		expect(specTargets(spec, 'Archive')).toBe(true);
	});

	it('true when the key is one of several targets in a multi-target section', () => {
		const spec = parseSortingSpec('target-folder: Archive\ntarget-folder: Inbox\n// shared\nItem', '/');
		expect(specTargets(spec, 'Inbox')).toBe(true);
	});

	it('false when nothing in the spec targets the key', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\nItem', '/');
		expect(specTargets(spec, 'Archive')).toBe(false);
	});

	it('false for an empty spec', () => {
		expect(specTargets(parseSortingSpec('', '/'), '/')).toBe(false);
	});

	it('does not care whether the matching section is authored by us or foreign', () => {
		const spec = parseSortingSpec('target-folder: .\nHand-written, no marker', 'Notes');
		expect(specTargets(spec, 'Notes')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// hasAuthoredSection — gates the vault-wide "hide sortspec.md" sync
// (syncHideSetting) so it only ever touches a folder this plugin already
// has a section for, never hand-written config and never a folder with no
// section at all.
// ---------------------------------------------------------------------------

describe('hasAuthoredSection', () => {
	it('true when the matching section carries our marker', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nA', 'Notes');
		expect(hasAuthoredSection(spec, '.')).toBe(true);
	});

	it('false when the matching section is hand-written (no marker)', () => {
		const spec = parseSortingSpec('target-folder: .\nHand-written, no marker', 'Notes');
		expect(hasAuthoredSection(spec, '.')).toBe(false);
	});

	it('false when nothing in the spec targets the key at all', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\n// explorer-order-editor\nA', '/');
		expect(hasAuthoredSection(spec, '.')).toBe(false);
	});

	it('false for an empty spec', () => {
		expect(hasAuthoredSection(parseSortingSpec('', '/'), '.')).toBe(false);
	});

	it('true if any one of several matching sections for the same key is authored', () => {
		const spec = parseSortingSpec(
			['target-folder: .', 'Hand-written', '', 'target-folder: .', '// explorer-order-editor', 'Ours'].join('\n'),
			'Notes',
		);
		expect(hasAuthoredSection(spec, '.')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// removeFolderOrder
// ---------------------------------------------------------------------------

describe('removeFolderOrder', () => {
	it('no matching section -> unchanged, same spec by identity', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\nX', '/');
		const result = removeFolderOrder(spec, '.');
		expect(result.status).toBe('unchanged');
		expect(result.spec).toBe(spec);
	});

	it('a foreign matching section is left untouched (only our own content is ever deleted)', () => {
		const spec = parseSortingSpec('target-folder: .\nForeign', '/');
		const result = removeFolderOrder(spec, '.');
		expect(result.status).toBe('unchanged');
		expect(serializeSortingSpec(result.spec)).toBe(serializeSortingSpec(spec));
	});

	it('removes an authored matching section, preserving neighbors byte-for-byte', () => {
		const spec = parseSortingSpec('target-folder: Before\nX\n\ntarget-folder: .\n// explorer-order-editor\nY\n\ntarget-folder: After\nZ', '/');
		const result = removeFolderOrder(spec, '.');
		expect(result.status).toBe('removed');
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: Before\nX\n\ntarget-folder: After\nZ');
	});

	it('removes every authored duplicate for the same target', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nA\n\ntarget-folder: .\n// explorer-order-editor\nB', '/');
		const result = removeFolderOrder(spec, '.');
		expect(result.status).toBe('removed');
		expect(result.spec.sections).toHaveLength(0);
	});

	it('blocks when the target falls inside a multi-target section', () => {
		const spec = parseSortingSpec('target-folder: A\ntarget-folder: B\n// shared\nItem', '/');
		const result = removeFolderOrder(spec, 'A');
		expect(result.status).toBe('blocked');
		expect(result.diagnostics).toEqual([{ kind: 'multi-target-conflict', targets: ['A', 'B'] }]);
	});
});

// ---------------------------------------------------------------------------
// Inverse property: serialize(remove(upsert(S, T, E))) === serialize(S), when
// S has no section matching T.
// ---------------------------------------------------------------------------

describe('inverse property: remove(upsert(S,T,E)) === S byte-for-byte', () => {
	const fixtures: readonly [string, string][] = [
		['empty spec', ''],
		['unrelated foreign section', 'target-folder: Archive\n// note\nOld'],
		['multiple unrelated sections', 'target-folder: A\nX\n\ntarget-folder: B\nY'],
		['prologue plus a section', '// header comment\n\ntarget-folder: Archive\nOld'],
	];

	it.each(fixtures)('%s', (_label, source) => {
		const S = parseSortingSpec(source, '/');
		const upserted = upsertFolderOrder(S, '.', [file('A'), folder('B')]);
		const removed = removeFolderOrder(upserted.spec, '.');
		expect(serializeSortingSpec(removed.spec)).toBe(serializeSortingSpec(S));
	});
});

// ---------------------------------------------------------------------------
// Fidelity: after an upsert, every non-matching section is reference-identical
// (and therefore byte-identical) to the input.
// ---------------------------------------------------------------------------

describe('fidelity: non-matching sections are untouched by reference', () => {
	it('survive an append', () => {
		const spec = parseSortingSpec('target-folder: A\nX\n\ntarget-folder: B\nY', '/');
		const result = upsertFolderOrder(spec, '.', [file('New')]);
		expect(result.spec.sections[0]).toBe(spec.sections[0]);
		expect(result.spec.sections[1]).toBe(spec.sections[1]);
	});

	it('survive a blocked mutation (whole spec returned by identity)', () => {
		const spec = parseSortingSpec('target-folder: A\ntarget-folder: B\n// shared\nItem\n\ntarget-folder: C\nZ', '/');
		const result = upsertFolderOrder(spec, 'A', [file('New')]);
		expect(result.spec).toBe(spec);
	});
});
