import { describe, expect, it } from 'vitest';
import { decodeEntryLine, parseSortingSpec, readFolderOrder, upsertFolderOrder } from '../src/sortspec';
import type { Entry } from '../src/types';

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
		['a name that is itself a reserved token', [file('/folders'), folder('/:files')]],
		[
			'names starting with attribute lexemes',
			[file('target-folder: x'), file('::::x'), file('<x'), file('>x'), file('with-metadata: x'), file('sorting: x')],
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
				file('/folders'),
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

describe('round trip holds across the full encodeEntry test matrix from sortspec.test.ts', () => {
	// Mirrors the reserved-token / attribute-lexeme / catch-all names exercised
	// there, but driven through the real upsert+read pipeline instead of
	// calling encodeEntry directly.
	const names: readonly string[] = [
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
		'target-folder: x',
		'::::x',
		'<x',
		'with-metadata: x',
		'%Report',
		'//comment',
		'--x',
		'Meeting notes',
	];

	it.each(names.map((n, i) => [i, n] as const))('file entry %i: %s', (_i, name) => {
		const entries: readonly Entry[] = [file(name)];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual(entries);
	});

	it.each(names.map((n, i) => [i, n] as const))('folder entry %i: %s', (_i, name) => {
		const entries: readonly Entry[] = [folder(name)];
		const written = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(readFolderOrder(written.spec, '.', entries)).toEqual(entries);
	});
});
