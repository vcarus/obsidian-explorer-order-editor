import { describe, expect, it } from 'vitest';
import { decodeEntryLine, parseSortingSpec, readFolderOrder, serializeSortingSpec, upsertFolderOrder } from '../src/sortspec';
import type { Entry } from '../src/types';

const SORTSPEC_FILENAME = 'sortspec.md';

const file = (name: string): Entry => ({ name, kind: 'file' });
const folder = (name: string): Entry => ({ name, kind: 'folder' });

// ---------------------------------------------------------------------------
// decodeEntryLine: everything that is NOT a plain item name decodes to null
// ---------------------------------------------------------------------------

describe('decodeEntryLine: not a plain item name -> null', () => {
	const nullCases: readonly [string, string][] = [
		['blank', ''],
		['whitespace only', '   '],
		['comment', '// hello'],
		['our own authored marker', '// explorer-order-editor'],
		['indented with spaces (belongs to a group)', '  Item'],
		['indented with a tab (belongs to a group)', '\tItem'],
		['target-folder: header', 'target-folder: Archive'],
		[':::: header', ':::: Archive'],
		['order-asc: instruction', 'order-asc: a-z'],
		['order-desc: instruction', 'order-desc: a-z'],
		['> sorting instruction', '> a-z'],
		['< sorting instruction', '< a-z'],
		['sorting: instruction', 'sorting: a-z'],
		['with-metadata: instruction', 'with-metadata: created'],
		['bookmarked: instruction', 'bookmarked: true'],
		['with-icon: instruction', 'with-icon: lucide-star'],
		['catch-all %', '%'],
		['catch-all /%', '/%'],
		['catch-all /folders:files', '/folders:files'],
		['catch-all /:files, alone', '/:files'],
		['catch-all /folders, alone', '/folders'],
		['catch-all ... alone', '...'],
		['wildcard anywhere in an otherwise plain name', 'a...b'],
		['wildcard inside a prefixed name', '/:files a...b'],
		["custom-sort's item-hide directive, bare token", '/--hide:'],
		["custom-sort's item-hide directive, with a name", '/--hide: sortspec.md'],
	];

	it.each(nullCases)('%s: %j', (_label, line) => {
		expect(decodeEntryLine(line)).toBeNull();
	});
});

describe('decodeEntryLine: type-prefixed names', () => {
	it('/folders <name> -> folder', () => {
		expect(decodeEntryLine('/folders Notes')).toEqual({ name: 'Notes', kind: 'folder' });
	});
	it('/ <name> -> folder (short alias)', () => {
		expect(decodeEntryLine('/ Notes')).toEqual({ name: 'Notes', kind: 'folder' });
	});
	it('/:files <name> -> file', () => {
		expect(decodeEntryLine('/:files Notes')).toEqual({ name: 'Notes', kind: 'file' });
	});
	it('/: <name> -> file (short alias)', () => {
		expect(decodeEntryLine('/: Notes')).toEqual({ name: 'Notes', kind: 'file' });
	});
	it('strips exactly one prefix layer, even if the remainder looks like another token', () => {
		expect(decodeEntryLine('/folders /folders')).toEqual({ name: '/folders', kind: 'folder' });
		expect(decodeEntryLine('/:files target-folder: x')).toEqual({ name: 'target-folder: x', kind: 'file' });
	});
});

describe('decodeEntryLine: bare unprefixed name defaults to file', () => {
	it('an ordinary bare name', () => {
		expect(decodeEntryLine('Meeting notes')).toEqual({ name: 'Meeting notes', kind: 'file' });
	});
});

// ---------------------------------------------------------------------------
// readFolderOrder
// ---------------------------------------------------------------------------

describe('readFolderOrder', () => {
	it('no matching section -> null', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\nA', '/');
		expect(readFolderOrder(spec, '.', [])).toBeNull();
	});

	it('the match is folded into a multi-target section -> null (cannot claim a single order)', () => {
		const spec = parseSortingSpec('target-folder: Archive\ntarget-folder: Inbox\n// shared\nItem', '/');
		expect(readFolderOrder(spec, 'Archive', [])).toBeNull();
	});

	it('more than one single-target section matches -> null (ambiguous, hand-edited duplicate)', () => {
		const spec = parseSortingSpec('target-folder: .\nA\n\ntarget-folder: .\nB', '/');
		expect(readFolderOrder(spec, '.', [])).toBeNull();
	});

	it('decodes a single-target section body in order, skipping comments/blanks/instructions/indented lines', () => {
		const spec = parseSortingSpec(
			['target-folder: .', '// explorer-order-editor', 'A', '', '// a comment', '  indented (group child)', 'sorting: a-z', 'B'].join('\n'),
			'/',
		);
		expect(readFolderOrder(spec, '.', [file('A'), file('B')])).toEqual([file('A'), file('B')]);
	});

	it('resolves a bare unprefixed name against siblings when the encoder default guess (file) is wrong', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nFoo', '/');
		// No siblings info at all -> falls back to the naive default (file).
		expect(readFolderOrder(spec, '.', [])).toEqual([file('Foo')]);
		// Siblings say "Foo" is actually a folder -> the override kicks in.
		expect(readFolderOrder(spec, '.', [folder('Foo')])).toEqual([folder('Foo')]);
	});
});

// ---------------------------------------------------------------------------
// Round-trip: readFolderOrder(upsertFolderOrder(empty, T, entries).spec, T,
// entries) deep-equals entries, for any fully representable Entry[]. This is
// the real acceptance criterion for the decoder.
// ---------------------------------------------------------------------------

describe('round trip: readFolderOrder(upsertFolderOrder(...)) === entries', () => {
	const corpora: readonly [string, readonly Entry[]][] = [
		['empty folder', []],
		['ordinary bare names, mixed kinds', [folder('Projects'), folder('Archive'), file('Welcome'), file('Todo')]],
		['a folder and a file sharing a name (forces prefixes on both)', [file('Notes'), folder('Notes')]],
		// A name that is itself a reserved token (e.g. bare "/folders") is no
		// longer representable at all -- see the dedicated describe block
		// below ("reserved-token names are never written..."). It doesn't
		// belong in this corpus list any more, since every entry here is
		// expected to round-trip losslessly.
		// 'with-metadata: x' used to be in this list; it no longer belongs here
		// for the same reason reserved-token names were pulled out above --
		// GROUP_BODY_LEXEMES ('with-metadata:', 'bookmarked:', 'with-icon:') are
		// unrepresentable too (see src/sortspec.ts and the dedicated coverage
		// in test/sortspec.test.ts), so there's nothing for them to round-trip.
		[
			'names starting with attribute lexemes',
			[file('target-folder: x'), file('::::x'), file('<x'), file('>x'), file('sorting: x')],
		],
		['catch-all-first-char names', [folder('%Report'), file('--dashes'), file('/slash-first')]],
		['a bare name with no collision, of each kind', [folder('Foo'), file('Bar')]],
		[
			'a large mixed folder',
			[
				folder('Zeta'),
				folder('Alpha'),
				file('Notes'),
				folder('Notes'),
				file('target-folder: trap'),
				// A near-miss on a reserved token -- starts with "/folders" but
				// isn't the complete leading word, so it's still representable
				// (unlike a bare "/folders", covered separately below).
				file('/folders-ish'),
				file('Ordinary name'),
			],
		],
	];

	it.each(corpora)('%s', (_label, entries) => {
		const empty = parseSortingSpec('', '/');
		const written = upsertFolderOrder(empty, '.', entries);
		expect(written.diagnostics).toEqual([]); // sanity: every entry above must be representable
		const decoded = readFolderOrder(written.spec, '.', entries);
		expect(decoded).toEqual(entries);
	});
});

// ---------------------------------------------------------------------------
// Reserved-token names (see encodeEntry's `reserved-token` reason in
// src/sortspec.ts): a name whose first space-delimited word is itself one of
// custom-sort's group-type/priority/combine prefix tokens can't be rescued
// by our own `/folders `/`/:files ` prefix -- prefixing just gives
// custom-sort's parser a second prefix token to find on the same line,
// which is a hard parse error that suspends the whole plugin (not just this
// line). upsertFolderOrder skips such entries instead of writing a line
// that would trigger that; correspondingly, they can never round-trip
// through readFolderOrder, because nothing was ever written for them.
// ---------------------------------------------------------------------------

describe('reserved-token names are never written, and so never round-trip', () => {
	it('upsertFolderOrder skips them with a reserved-token diagnostic; readFolderOrder sees only the rest', () => {
		const entries: readonly Entry[] = [file('/folders'), folder('/:files'), file('--% hidden'), file('Ordinary name')];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(written.diagnostics).toEqual([
			{ kind: 'unrepresentable-entry', name: '/folders', reason: 'reserved-token' },
			{ kind: 'unrepresentable-entry', name: '/:files', reason: 'reserved-token' },
			{ kind: 'unrepresentable-entry', name: '--% hidden', reason: 'reserved-token' },
		]);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual([file('Ordinary name')]);
	});

	it('the exact reported bug: "--% hidden" never appears in the written spec at all', () => {
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('--% hidden')]);
		expect(serializeSortingSpec(written.spec)).not.toContain('--%');
	});
});

describe('round trip holds across the full encodeEntry test matrix from sortspec.test.ts', () => {
	// Mirrors the attribute-lexeme / catch-all names exercised there, driven
	// through the real upsert+read pipeline instead of calling encodeEntry
	// directly. These are all representable, so a full round trip applies.
	const representableNames: readonly string[] = [
		// Reserved tokens stuck to more text with no space boundary are safe
		// (the "/folders" here is a prefix of a longer word, not the whole
		// first token) -- unlike the bare/word-boundary cases exercised in
		// unrepresentableNames below.
		'/foldersXYZ',
		'target-folder: x',
		'::::x',
		'<x',
		// 'with-metadata: x' deliberately excluded -- no longer representable,
		// see the note above the 'names starting with attribute lexemes' corpus.
		'%Report',
		'//comment',
		'--x',
		'Meeting notes',
	];

	it.each(representableNames.map((n, i) => [i, n] as const))('file entry %i: %s', (_i, name) => {
		const entries: readonly Entry[] = [file(name)];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(written.diagnostics).toEqual([]);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual(entries);
	});

	it.each(representableNames.map((n, i) => [i, n] as const))('folder entry %i: %s', (_i, name) => {
		const entries: readonly Entry[] = [folder(name)];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(written.diagnostics).toEqual([]);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual(entries);
	});

	// The full 17-token reserved set, plus a reserved token followed by more
	// text -- every one of these is unrepresentable (see
	// `test/sortspec.test.ts`'s `reservedTokenCases`/`otherCases`). Included
	// here, against the real upsert+read pipeline, as defence in depth: even
	// though a name containing "/" (13 of these 17 tokens) can never occur in
	// a real POSIX filename, custom-sort's own syntax doesn't know that, so
	// they're covered anyway.
	const unrepresentableNames: readonly string[] = [
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
		'/folders rest of name',
	];

	it.each(unrepresentableNames.map((n, i) => [i, n] as const))('file entry %i: %s is skipped, not round-tripped', (_i, name) => {
		const entries: readonly Entry[] = [file(name)];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(written.diagnostics).toEqual([{ kind: 'unrepresentable-entry', name, reason: 'reserved-token' }]);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual([]);
	});

	it.each(unrepresentableNames.map((n, i) => [i, n] as const))('folder entry %i: %s is skipped, not round-tripped', (_i, name) => {
		const entries: readonly Entry[] = [folder(name)];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(written.diagnostics).toEqual([{ kind: 'unrepresentable-entry', name, reason: 'reserved-token' }]);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// LINE_ATTRIBUTE_LEXEMES round trip: names that only became representable --
// with a forced prefix -- once needsTypePrefix started matching
// custom-sort's own `ro` line-attribute map case-insensitively (see
// src/sortspec.ts). Unlike GROUP_BODY_LEXEMES, prefixing genuinely rescues
// every one of these, so each must round-trip exactly like any other
// prefixed name: this is the real acceptance criterion for the fix, the same
// way the corpora above are for encodeEntry's existing behavior.
// ---------------------------------------------------------------------------

describe("round trip: names colliding with custom-sort's ro map, case-insensitively or via a no-colon key", () => {
	const names: readonly string[] = [
		'desc x',
		'Desc x',
		'DESC x',
		'asc x',
		'order-asc x',
		'order-desc x',
		'Order-Desc: x',
		'SORTING: x',
		'Target-Folder: x',
		'description',
		'descent',
		'ascending notes',
		'Ascii art',
		'describe',
	];

	it.each(names.map((n, i) => [i, n] as const))('file entry %i: %s', (_i, name) => {
		const entries: readonly Entry[] = [file(name)];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(written.diagnostics).toEqual([]);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual(entries);
	});

	it.each(names.map((n, i) => [i, n] as const))('folder entry %i: %s', (_i, name) => {
		const entries: readonly Entry[] = [folder(name)];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(written.diagnostics).toEqual([]);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual(entries);
	});
});

// ---------------------------------------------------------------------------
// hideNames does not leak into the decoded order: the "hide sortspec.md"
// setting writes a "/--hide: sortspec.md" line into the same authored
// section as the entries, and it must never come back as a phantom entry.
// ---------------------------------------------------------------------------

describe('a "/--hide:" line written alongside entries never decodes as an entry', () => {
	it('readFolderOrder returns exactly the real entries, hide line excluded', () => {
		const entries: readonly Entry[] = [folder('Projects'), file('Welcome')];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries, [SORTSPEC_FILENAME]);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual(entries);
	});

	it('holds even with zero orderable entries (hide line is the only body content)', () => {
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', [], [SORTSPEC_FILENAME]);
		expect(readFolderOrder(written.spec, '.', [])).toEqual([]);
	});
});
