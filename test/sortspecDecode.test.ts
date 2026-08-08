import { describe, expect, it } from 'vitest';
import { decodeEntryLine, parseSortingSpec, readFolderOrder } from '../src/sortspec';
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
