import { describe, expect, it } from 'vitest';
import {
	getOrder,
	mergeIndexesByPrecedence,
	mergeOrder,
	parseIndex,
	pruneMissing,
	recoverIndex,
	removeEntry,
	removeOrder,
	renameEntry,
	renameFolderPath,
	salvageIndex,
	serializeIndex,
	setOrder,
	type OrderIndex,
} from '../src/orderIndex';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Builds an `OrderIndex` from plain entries, in whatever order they're given. */
function buildIndex(entries: readonly (readonly [string, readonly string[]])[]): OrderIndex {
	return new Map(entries);
}

/** Sorted [key, names] pairs, for equality checks that don't depend on Map iteration order. */
function sortedEntries(index: OrderIndex): (readonly [string, readonly string[]])[] {
	return [...index.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function expectIndexEqual(actual: OrderIndex, expected: OrderIndex): void {
	expect(sortedEntries(actual)).toEqual(sortedEntries(expected));
}

/** Extracts the lines strictly between the first ```json / ``` fence pair, black-box (independent of orderIndex.ts's own scanner). */
function blockBodyLines(noteText: string): string[] {
	const lines = noteText.split('\n');
	const open = lines.findIndex((l) => l.trimEnd() === '```json');
	expect(open).toBeGreaterThanOrEqual(0);
	const close = lines.slice(open + 1).findIndex((l) => l.trimEnd() === '```');
	expect(close).toBeGreaterThanOrEqual(0);
	return lines.slice(open + 1, open + 1 + close);
}

const empty: OrderIndex = new Map();

// ---------------------------------------------------------------------------
// Round trip / idempotence / determinism
// ---------------------------------------------------------------------------

describe('round trip: parseIndex(serializeIndex(text, i)) === i', () => {
	const startingTexts = [
		'',
		'Some prose, no block yet.',
		'Some prose, no block yet.\n',
		'---\nfoo: bar\n---\n\nBody text.\n',
	];

	const indexes: readonly OrderIndex[] = [
		empty,
		buildIndex([['Projects/Alpha', ['Design.md', 'Notes', 'TODO.md']]]),
		buildIndex([
			['Projects/Alpha', ['Design.md', 'Notes', 'TODO.md']],
			['Projects/Beta', ['b.md', 'a.md']],
			['/', ['Welcome.md', 'Inbox']],
		]),
	];

	for (const text of startingTexts) {
		for (const [i, index] of indexes.entries()) {
			it(`text=${JSON.stringify(text)} index#${i}`, () => {
				const serialized = serializeIndex(text, index);
				const result = parseIndex(serialized);
				expect(result.status).toBe('ok');
				if (result.status === 'ok') expectIndexEqual(result.index, index);
			});
		}
	}

	it('round-trips through an already-existing block too, not just a freshly-appended one', () => {
		const first = serializeIndex('Prose.\n', buildIndex([['A', ['x.md']]]));
		const second = serializeIndex(first, buildIndex([['A', ['x.md']], ['B', ['y.md']]]));
		const result = parseIndex(second);
		expect(result.status).toBe('ok');
		if (result.status === 'ok') {
			expectIndexEqual(
				result.index,
				buildIndex([
					['A', ['x.md']],
					['B', ['y.md']],
				]),
			);
		}
	});
});

describe('idempotence: serializing twice produces byte-identical output', () => {
	it('from empty note text', () => {
		const index = buildIndex([['A', ['x.md', 'y.md']]]);
		const once = serializeIndex('', index);
		const twice = serializeIndex(once, index);
		expect(twice).toBe(once);
	});

	it('from note text with no block yet', () => {
		const index = buildIndex([['A', ['x.md']]]);
		const once = serializeIndex('Some prose.\n', index);
		const twice = serializeIndex(once, index);
		expect(twice).toBe(once);
	});

	it('from note text with an existing block', () => {
		const index = buildIndex([['A', ['x.md']]]);
		const withBlock = serializeIndex('Prose.\n', index);
		const again = serializeIndex(withBlock, index);
		expect(again).toBe(withBlock);
	});
});

describe('deterministic key order: insertion order does not affect serialized output', () => {
	it('two indexes built by inserting the same keys in different orders serialize identically', () => {
		const a = buildIndex([
			['Projects/Alpha', ['x.md']],
			['Archive', ['y.md']],
			['Projects/Beta', ['z.md']],
		]);
		const b = buildIndex([
			['Projects/Beta', ['z.md']],
			['Archive', ['y.md']],
			['Projects/Alpha', ['x.md']],
		]);
		expect(serializeIndex('', a)).toBe(serializeIndex('', b));
	});
});

describe('one line per folder', () => {
	it('the serialized block body has exactly one line per key', () => {
		const index = buildIndex([
			['Projects/Alpha', ['Design.md', 'Notes', 'TODO.md']],
			['Projects/Beta', ['b.md', 'a.md']],
			['Archive', ['old.md']],
		]);
		const lines = blockBodyLines(serializeIndex('', index));
		// `{` and `}` are on their own lines; the rest is exactly one line per key.
		expect(lines[0]).toBe('{');
		expect(lines[lines.length - 1]).toBe('}');
		expect(lines.length - 2).toBe(3);
		for (const line of lines.slice(1, -1)) {
			expect(line.includes('\n')).toBe(false);
		}
	});

	it('an empty index serializes its block body as the single line "{}"', () => {
		const lines = blockBodyLines(serializeIndex('', empty));
		expect(lines).toEqual(['{}']);
	});
});

// ---------------------------------------------------------------------------
// Fidelity
// ---------------------------------------------------------------------------

describe('fidelity: everything outside the ```json block survives a serialize byte-for-byte', () => {
	it('prose before/after the block, an unrelated fenced block, and front matter are untouched', () => {
		const before = [
			'---',
			'title: My note',
			'tags: [a, b]',
			'---',
			'',
			'Prose before the block.',
			'',
			'```other',
			'unrelated fenced content',
			'with multiple lines',
			'```',
			'',
			'```json',
			'{',
			'  "A": ["old.md"]',
			'}',
			'```',
			'',
			'Prose after the block.',
			'',
		].join('\n');

		const newIndex = buildIndex([['A', ['new.md']]]);
		const result = serializeIndex(before, newIndex);
		const resultLines = result.split('\n');

		// Everything up to and including the opening json fence is unchanged.
		const openIndex = before.split('\n').findIndex((l) => l === '```json');
		expect(resultLines.slice(0, openIndex + 1)).toEqual(before.split('\n').slice(0, openIndex + 1));

		// Everything from the closing json fence onward is unchanged.
		const closeIndex = before.split('\n').findIndex((l, i) => i > openIndex && l === '```');
		const newCloseIndex = resultLines.findIndex((l, i) => i > openIndex && l === '```');
		expect(resultLines.slice(newCloseIndex)).toEqual(before.split('\n').slice(closeIndex));

		// The unrelated fenced block survived verbatim, front matter included.
		expect(result).toContain('---\ntitle: My note\ntags: [a, b]\n---');
		expect(result).toContain('```other\nunrelated fenced content\nwith multiple lines\n```');
		expect(result).toContain('Prose before the block.');
		expect(result).toContain('Prose after the block.');

		// And the json block itself did change, to the new index.
		const parsed = parseIndex(result);
		expect(parsed.status).toBe('ok');
		if (parsed.status === 'ok') expectIndexEqual(parsed.index, newIndex);
	});
});

// ---------------------------------------------------------------------------
// setOrder / removeOrder / getOrder
// ---------------------------------------------------------------------------

describe('inverse: removeOrder(setOrder(i, p, names), p) === i when p was absent', () => {
	it('serializes identically to the original', () => {
		const i = buildIndex([['Other', ['a.md']]]);
		const mutated = removeOrder(setOrder(i, 'New/Folder', ['x.md', 'y.md']), 'New/Folder');
		expect(serializeIndex('', mutated)).toBe(serializeIndex('', i));
	});
});

describe('setOrder', () => {
	it('an empty names array removes the key instead of storing []', () => {
		const i = setOrder(empty, 'A', ['x.md']);
		const cleared = setOrder(i, 'A', []);
		expect(getOrder(cleared, 'A')).toBeUndefined();
		expectIndexEqual(cleared, empty);
	});

	it('de-duplicates names, keeping the first occurrence', () => {
		const i = setOrder(empty, 'A', ['x.md', 'y.md', 'x.md', 'z.md', 'y.md']);
		expect(getOrder(i, 'A')).toEqual(['x.md', 'y.md', 'z.md']);
	});

	it('does not mutate its argument', () => {
		const original = buildIndex([['A', ['x.md']]]);
		const snapshot = sortedEntries(original);
		setOrder(original, 'A', ['q.md']);
		setOrder(original, 'B', ['q.md']);
		expect(sortedEntries(original)).toEqual(snapshot);
	});

	it('overwrites an existing order for the same folder', () => {
		const i = setOrder(empty, 'A', ['x.md']);
		const j = setOrder(i, 'A', ['y.md', 'z.md']);
		expect(getOrder(j, 'A')).toEqual(['y.md', 'z.md']);
	});
});

describe('removeOrder', () => {
	it('returns the same reference when the key is already absent', () => {
		const i = buildIndex([['A', ['x.md']]]);
		expect(removeOrder(i, 'NotThere')).toBe(i);
	});

	it('does not mutate its argument', () => {
		const original = buildIndex([['A', ['x.md']]]);
		const snapshot = sortedEntries(original);
		removeOrder(original, 'A');
		expect(sortedEntries(original)).toEqual(snapshot);
	});
});

// ---------------------------------------------------------------------------
// renameFolderPath
// ---------------------------------------------------------------------------

describe('renameFolderPath', () => {
	it('remaps the key itself', () => {
		const i = buildIndex([['Projects', ['a.md']]]);
		const renamed = renameFolderPath(i, 'Projects', 'Work');
		expect(getOrder(renamed, 'Projects')).toBeUndefined();
		expect(getOrder(renamed, 'Work')).toEqual(['a.md']);
	});

	it('remaps every descendant key', () => {
		const i = buildIndex([
			['Projects', ['a.md']],
			['Projects/Alpha', ['x.md']],
			['Projects/Alpha/Deep', ['y.md']],
			['Projects/Beta', ['z.md']],
		]);
		const renamed = renameFolderPath(i, 'Projects', 'Work');
		expectIndexEqual(
			renamed,
			buildIndex([
				['Work', ['a.md']],
				['Work/Alpha', ['x.md']],
				['Work/Alpha/Deep', ['y.md']],
				['Work/Beta', ['z.md']],
			]),
		);
	});

	it('leaves a sibling key that merely shares the renamed name as a text prefix untouched', () => {
		// The single most likely bug in this module: matching on the bare
		// string prefix `oldPath` (not `oldPath + '/'`) would wrongly also
		// remap "ProjectsOld/Notes" when renaming "Projects".
		const i = buildIndex([
			['Projects', ['a.md']],
			['Projects/Notes', ['b.md']],
			['ProjectsOld', ['c.md']],
			['ProjectsOld/Notes', ['d.md']],
		]);
		const renamed = renameFolderPath(i, 'Projects', 'Work');
		expectIndexEqual(
			renamed,
			buildIndex([
				['Work', ['a.md']],
				['Work/Notes', ['b.md']],
				['ProjectsOld', ['c.md']],
				['ProjectsOld/Notes', ['d.md']],
			]),
		);
	});

	it('returns the same reference when neither the path nor any descendant is present', () => {
		const i = buildIndex([['Elsewhere', ['a.md']]]);
		expect(renameFolderPath(i, 'Projects', 'Work')).toBe(i);
	});

	it('does not mutate its argument', () => {
		const original = buildIndex([
			['Projects', ['a.md']],
			['Projects/Alpha', ['x.md']],
		]);
		const snapshot = sortedEntries(original);
		renameFolderPath(original, 'Projects', 'Work');
		expect(sortedEntries(original)).toEqual(snapshot);
	});
});

// ---------------------------------------------------------------------------
// renameEntry
// ---------------------------------------------------------------------------

describe('an unterminated json block', () => {
	const dangling = 'Some prose.\n\n```json\n{ "A": ["x.md"] }\n';

	it('parses as invalid, not as an absent block', () => {
		const result = parseIndex(dangling);
		expect(result.status).toBe('invalid');
	});

	it('refuses to be written to, rather than appending a second block the next read cannot delimit', () => {
		// Appending here would leave the dangling fence in front of the new
		// block: the next scan would run from that fence to the new block's
		// closing fence and try to parse the prose in between, so the order
		// just written would be permanently unreadable.
		expect(() => serializeIndex(dangling, setOrder(empty, 'A', ['x.md']))).toThrow();
	});
});

describe('renameEntry', () => {
	it('preserves position: swaps the name in place without disturbing order', () => {
		const i = setOrder(empty, 'A', ['x.md', 'y.md', 'z.md']);
		const renamed = renameEntry(i, 'A', 'y.md', 'y2.md');
		expect(getOrder(renamed, 'A')).toEqual(['x.md', 'y2.md', 'z.md']);
	});

	it('returns the index unchanged (same reference) for an unknown name', () => {
		const i = setOrder(empty, 'A', ['x.md']);
		expect(renameEntry(i, 'A', 'missing.md', 'new.md')).toBe(i);
	});

	it('returns the index unchanged (same reference) for an unknown folder', () => {
		const i = setOrder(empty, 'A', ['x.md']);
		expect(renameEntry(i, 'NoSuchFolder', 'x.md', 'new.md')).toBe(i);
	});

	it('does not mutate its argument', () => {
		const original = setOrder(empty, 'A', ['x.md', 'y.md']);
		const snapshot = sortedEntries(original);
		renameEntry(original, 'A', 'x.md', 'x2.md');
		expect(sortedEntries(original)).toEqual(snapshot);
	});

	it('keeps stored orders duplicate-free: renaming onto a name already present drops the other one', () => {
		// Reachable by deleting b.md and renaming a.md to b.md, if the two
		// events are applied in the other order. The renamed entry keeps its
		// own position; the stale occurrence is what goes.
		const i = setOrder(empty, 'A', ['b.md', 'x.md', 'a.md']);
		const renamed = renameEntry(i, 'A', 'a.md', 'b.md');
		expect(getOrder(renamed, 'A')).toEqual(['x.md', 'b.md']);
	});
});

// ---------------------------------------------------------------------------
// removeEntry
// ---------------------------------------------------------------------------

describe('removeEntry', () => {
	it('drops the named entry, keeping the rest in order', () => {
		const i = setOrder(empty, 'A', ['x.md', 'y.md', 'z.md']);
		const removed = removeEntry(i, 'A', 'y.md');
		expect(getOrder(removed, 'A')).toEqual(['x.md', 'z.md']);
	});

	it('removes the key entirely when that was the only entry', () => {
		const i = setOrder(empty, 'A', ['x.md']);
		const removed = removeEntry(i, 'A', 'x.md');
		expect(getOrder(removed, 'A')).toBeUndefined();
		expectIndexEqual(removed, empty);
	});

	it('returns the same reference when the folder has no stored order', () => {
		const i = buildIndex([['Other', ['a.md']]]);
		expect(removeEntry(i, 'A', 'x.md')).toBe(i);
	});

	it('returns the same reference when the name is not in the stored order', () => {
		const i = setOrder(empty, 'A', ['x.md']);
		expect(removeEntry(i, 'A', 'missing.md')).toBe(i);
	});
});

// ---------------------------------------------------------------------------
// pruneMissing
// ---------------------------------------------------------------------------

describe('pruneMissing', () => {
	it('drops keys not present in existingFolderPaths', () => {
		const i = buildIndex([
			['A', ['x.md']],
			['B', ['y.md']],
			['C', ['z.md']],
		]);
		const pruned = pruneMissing(i, new Set(['A', 'C']));
		expectIndexEqual(pruned, buildIndex([['A', ['x.md']], ['C', ['z.md']]]));
	});

	it('returns the same reference when nothing is dropped', () => {
		const i = buildIndex([['A', ['x.md']]]);
		expect(pruneMissing(i, new Set(['A', 'B']))).toBe(i);
	});

	it('does not mutate its argument', () => {
		const original = buildIndex([
			['A', ['x.md']],
			['B', ['y.md']],
		]);
		const snapshot = sortedEntries(original);
		pruneMissing(original, new Set(['A']));
		expect(sortedEntries(original)).toEqual(snapshot);
	});
});

// ---------------------------------------------------------------------------
// parseIndex — invalid / empty cases
// ---------------------------------------------------------------------------

describe('parseIndex: never throws, never falls back to an empty index on bad input', () => {
	it('malformed JSON -> invalid', () => {
		const text = ['```json', '{ this is not json', '```'].join('\n');
		expect(() => parseIndex(text)).not.toThrow();
		const result = parseIndex(text);
		expect(result.status).toBe('invalid');
	});

	it('a top-level JSON array -> invalid', () => {
		const text = ['```json', '["A", "B"]', '```'].join('\n');
		expect(parseIndex(text).status).toBe('invalid');
	});

	it('a top-level JSON string -> invalid', () => {
		const text = ['```json', '"just a string"', '```'].join('\n');
		expect(parseIndex(text).status).toBe('invalid');
	});

	it('a top-level JSON null -> invalid', () => {
		const text = ['```json', 'null', '```'].join('\n');
		expect(parseIndex(text).status).toBe('invalid');
	});

	it('an object whose value is not an array -> invalid', () => {
		const text = ['```json', '{"A": "not-an-array"}', '```'].join('\n');
		expect(parseIndex(text).status).toBe('invalid');
	});

	it('an object whose array contains a non-string -> invalid', () => {
		const text = ['```json', '{"A": ["x.md", 42]}', '```'].join('\n');
		expect(parseIndex(text).status).toBe('invalid');
	});

	it('an invalid reason is a non-empty human-readable string', () => {
		const result = parseIndex(['```json', 'not json at all', '```'].join('\n'));
		if (result.status === 'invalid') {
			expect(typeof result.reason).toBe('string');
			expect(result.reason.length).toBeGreaterThan(0);
		} else {
			throw new Error('expected invalid');
		}
	});

	it('a note with no json block at all -> empty', () => {
		expect(parseIndex('').status).toBe('empty');
		expect(parseIndex('Just some prose, no code fence here.').status).toBe('empty');
		expect(parseIndex('```other\nnot json\n```').status).toBe('empty');
	});

	it('a valid object with an empty array value -> ok, not invalid', () => {
		const text = ['```json', '{"A": []}', '```'].join('\n');
		const result = parseIndex(text);
		expect(result.status).toBe('ok');
		if (result.status === 'ok') expect(getOrder(result.index, 'A')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Names needing JSON escaping
// ---------------------------------------------------------------------------

describe('names needing JSON escaping survive a round trip', () => {
	it('quotes, backslashes, #, :, [[, emoji, and CJK all round-trip exactly', () => {
		const trickyNames = [
			'Say "hello".md',
			'back\\slash.md',
			'# heading style.md',
			'time: 12:30.md',
			'[[wikilink]] style.md',
			'\u{1F600} emoji.md',
			'中文笔记.md',
		];
		const trickyFolder = 'Folder "with" quotes/日本語';
		const index = buildIndex([[trickyFolder, trickyNames]]);

		const serialized = serializeIndex('', index);
		const result = parseIndex(serialized);
		expect(result.status).toBe('ok');
		if (result.status === 'ok') {
			expect(getOrder(result.index, trickyFolder)).toEqual(trickyNames);
		}
	});
});

// ---------------------------------------------------------------------------
// mergeOrder
// ---------------------------------------------------------------------------

describe('mergeOrder', () => {
	it('stored-first ordering: stored names that still exist keep stored order', () => {
		const stored = ['c.md', 'a.md', 'b.md'];
		const live = ['a.md', 'b.md', 'c.md'];
		expect(mergeOrder(stored, live)).toEqual(['c.md', 'a.md', 'b.md']);
	});

	it('unmentioned live names keep their incoming (non-alphabetical) order, appended after stored names', () => {
		const stored = ['b.md'];
		// Deliberately non-alphabetical arrival order.
		const live = ['z.md', 'a.md', 'b.md', 'm.md'];
		expect(mergeOrder(stored, live)).toEqual(['b.md', 'z.md', 'a.md', 'm.md']);
	});

	it('stored names absent from live are dropped', () => {
		const stored = ['gone.md', 'a.md'];
		const live = ['a.md', 'b.md'];
		expect(mergeOrder(stored, live)).toEqual(['a.md', 'b.md']);
	});

	it('duplicates in stored are ignored after the first', () => {
		const stored = ['a.md', 'b.md', 'a.md'];
		const live = ['a.md', 'b.md'];
		expect(mergeOrder(stored, live)).toEqual(['a.md', 'b.md']);
	});

	it('stored undefined -> the live order, unchanged', () => {
		const live = ['z.md', 'a.md'];
		expect(mergeOrder(undefined, live)).toEqual(live);
	});

	it('empty stored -> the live order, unchanged', () => {
		const live = ['z.md', 'a.md'];
		expect(mergeOrder([], live)).toEqual(live);
	});

	it('does not mutate liveNames', () => {
		const live = ['z.md', 'a.md'];
		const snapshot = [...live];
		mergeOrder(['a.md'], live);
		expect(live).toEqual(snapshot);
	});
});

// ---------------------------------------------------------------------------
// salvageIndex (M10e)
// ---------------------------------------------------------------------------

describe('salvageIndex', () => {
	it('recovers every line of an otherwise-valid block, with zero dropped', () => {
		const text = ['```json', '{', '  "A": ["x.md", "y.md"],', '  "B": ["z.md"]', '}', '```'].join('\n');
		const result = salvageIndex(text);
		expect(result.droppedLines).toBe(0);
		expectIndexEqual(result.index, buildIndex([['A', ['x.md', 'y.md']], ['B', ['z.md']]]));
	});

	it('the { and } lines are structural, not data, and are not counted as dropped', () => {
		const text = ['```json', '{', '  "A": ["x.md"]', '}', '```'].join('\n');
		const result = salvageIndex(text);
		expect(result.droppedLines).toBe(0);
	});

	it('blank lines inside the block are not counted as dropped', () => {
		const text = ['```json', '{', '', '  "A": ["x.md"]', '', '}', '```'].join('\n');
		const result = salvageIndex(text);
		expect(result.droppedLines).toBe(0);
		expectIndexEqual(result.index, buildIndex([['A', ['x.md']]]));
	});

	it('a note whose json block cannot be located returns an empty index and 0 dropped', () => {
		expect(salvageIndex('')).toEqual({ index: new Map(), droppedLines: 0 });
		expect(salvageIndex('Just prose, no fence anywhere.')).toEqual({ index: new Map(), droppedLines: 0 });
		expect(salvageIndex('```other\nnot json\n```')).toEqual({ index: new Map(), droppedLines: 0 });
	});

	it('a line whose value is not an array of strings is dropped and counted, surrounding lines survive', () => {
		const text = ['```json', '{', '  "A": ["x.md"],', '  "B": "not-an-array",', '  "C": ["y.md", 42],', '  "D": ["z.md"]', '}', '```'].join(
			'\n',
		);
		const result = salvageIndex(text);
		expect(result.droppedLines).toBe(2);
		expectIndexEqual(result.index, buildIndex([['A', ['x.md']], ['D', ['z.md']]]));
	});

	it('git conflict markers sitting among good lines are dropped, and folder lines from both sides survive', () => {
		const text = [
			'```json',
			'{',
			'  "Projects/Alpha": ["Design.md"],',
			'<<<<<<< HEAD',
			'  "Projects/Beta": ["b.md", "a.md"],',
			'=======',
			'  "Projects/Beta": ["a.md", "b.md", "c.md"],',
			'  "Projects/Gamma": ["g.md"],',
			'>>>>>>> branch',
			'  "Projects/Delta": ["d.md"]',
			'}',
			'```',
		].join('\n');
		const result = salvageIndex(text);
		// Three marker lines (<<<<<<<, =======, >>>>>>>) don't parse as a pair.
		expect(result.droppedLines).toBe(3);
		// Both sides' distinct keys survive; the conflicting key ("Projects/Beta")
		// resolves to whichever copy appears later in the file, matching
		// JSON.parse's own last-write-wins semantics for a repeated key.
		expectIndexEqual(
			result.index,
			buildIndex([
				['Projects/Alpha', ['Design.md']],
				['Projects/Beta', ['a.md', 'b.md', 'c.md']],
				['Projects/Gamma', ['g.md']],
				['Projects/Delta', ['d.md']],
			]),
		);
	});

	it('later duplicate keys win over earlier ones, matching JSON.parse semantics', () => {
		const text = ['```json', '{', '  "A": ["first.md"],', '  "A": ["second.md"]', '}', '```'].join('\n');
		const result = salvageIndex(text);
		expect(getOrder(result.index, 'A')).toEqual(['second.md']);
	});

	it('a truncated final line is dropped and counted; earlier good lines survive', () => {
		// No closing fence at all -- the file just stops mid-line, as a
		// half-written / interrupted-mid-write copy would look.
		const text = ['```json', '{', '  "A": ["a.md"],', '  "B": ["b'].join('\n');
		const result = salvageIndex(text);
		expect(result.droppedLines).toBe(1);
		expectIndexEqual(result.index, buildIndex([['A', ['a.md']]]));
	});

	it('an unterminated fence is still salvaged to EOF, unlike parseIndex which refuses the whole block', () => {
		const text = ['```json', '{', '  "A": ["a.md"],', '  "B": ["b.md"]', '}'].join('\n');
		expect(parseIndex(text).status).toBe('invalid');
		const result = salvageIndex(text);
		expect(result.droppedLines).toBe(0);
		expectIndexEqual(result.index, buildIndex([['A', ['a.md']], ['B', ['b.md']]]));
	});

	it('malformed JSON on a line (not just wrong shape) is dropped and counted', () => {
		const text = ['```json', '{', '  "A": ["a.md"],', '  this is not json at all,', '  "B": ["b.md"]', '}', '```'].join('\n');
		const result = salvageIndex(text);
		expect(result.droppedLines).toBe(1);
		expectIndexEqual(result.index, buildIndex([['A', ['a.md']], ['B', ['b.md']]]));
	});
});

describe('salvageIndex without a fence', () => {
	it('recovers the data lines when the ```json fence itself was deleted', () => {
		const mangled = [
			'This note is maintained by the Explorer Order Editor plugin.',
			'',
			'{',
			'  "A": ["x.md", "y.md"],',
			'  "B": ["z.md"]',
			'}',
		].join('\n');
		const { index, droppedLines } = salvageIndex(mangled);
		expect(sortedEntries(index)).toEqual([
			['A', ['x.md', 'y.md']],
			['B', ['z.md']],
		]);
		// Outside a fence, a line that does not parse cannot be told apart from
		// prose that was never data, so nothing is reported as lost.
		expect(droppedLines).toBe(0);
	});

	it('reports nothing for a note that is only prose', () => {
		const { index, droppedLines } = salvageIndex('Just some writing.\n\nAnd more.\n');
		expect(index.size).toBe(0);
		expect(droppedLines).toBe(0);
	});
});


// ---------------------------------------------------------------------------
// mergeIndexesByPrecedence / recoverIndex (M10e)
// ---------------------------------------------------------------------------

describe('mergeIndexesByPrecedence', () => {
	it('an empty sources array yields an empty index', () => {
		expectIndexEqual(mergeIndexesByPrecedence([]), empty);
	});

	it('a single source is returned as-is (its keys, unchanged)', () => {
		const i = buildIndex([['A', ['x.md']]]);
		expectIndexEqual(mergeIndexesByPrecedence([i]), i);
	});

	it('the earliest source in the array wins for a key present in more than one', () => {
		const first = buildIndex([['A', ['from-first.md']]]);
		const second = buildIndex([['A', ['from-second.md']]]);
		const third = buildIndex([['A', ['from-third.md']]]);
		expect(getOrder(mergeIndexesByPrecedence([first, second, third]), 'A')).toEqual(['from-first.md']);
	});

	it('is a union: keys unique to a lower-precedence source are still present', () => {
		const highest = buildIndex([['A', ['a.md']]]);
		const middle = buildIndex([['B', ['b.md']]]);
		const lowest = buildIndex([['C', ['c.md']]]);
		expectIndexEqual(
			mergeIndexesByPrecedence([highest, middle, lowest]),
			buildIndex([
				['A', ['a.md']],
				['B', ['b.md']],
				['C', ['c.md']],
			]),
		);
	});

	it('never lets a lower-precedence source override a key a higher one still has, even partially', () => {
		// The single most likely bug: naively spreading sources in array order
		// (`{...sources[0], ...sources[1], ...}`) would let the *last* source
		// win instead of the first. This pins the direction down.
		const highest = buildIndex([
			['A', ['keep-this.md']],
			['B', ['keep-this-too.md']],
		]);
		const lowest = buildIndex([
			['A', ['must-not-appear.md']],
			['B', ['must-not-appear-either.md']],
			['C', ['this-one-is-fine.md']],
		]);
		const merged = mergeIndexesByPrecedence([highest, lowest]);
		expect(getOrder(merged, 'A')).toEqual(['keep-this.md']);
		expect(getOrder(merged, 'B')).toEqual(['keep-this-too.md']);
		expect(getOrder(merged, 'C')).toEqual(['this-one-is-fine.md']);
	});
});

describe('recoverIndex', () => {
	it('unions salvage, memory, and backup, salvage winning conflicts, memory next, backup last', () => {
		const unreadableText = [
			'```json',
			'{',
			'  "FromSalvageOnly": ["s.md"],',
			'  "InBoth": ["from-salvage.md"]',
			'}',
			'```',
		].join('\n');
		const memory = buildIndex([
			['InBoth', ['from-memory.md']],
			['FromMemoryOnly', ['m.md']],
		]);
		const backup = buildIndex([
			['InBoth', ['from-backup.md']],
			['FromMemoryOnly', ['stale.md']],
			['FromBackupOnly', ['b.md']],
		]);

		const result = recoverIndex(unreadableText, memory, backup);
		expect(result.droppedLines).toBe(0);
		expectIndexEqual(
			result.index,
			buildIndex([
				['FromSalvageOnly', ['s.md']],
				['InBoth', ['from-salvage.md']],
				['FromMemoryOnly', ['m.md']],
				['FromBackupOnly', ['b.md']],
			]),
		);
	});

	it('reports salvageIndex\'s dropped-line count', () => {
		const unreadableText = ['```json', '{', '  "A": ["a.md"],', 'garbage,', '  "B": ["b.md"]', '}', '```'].join('\n');
		const result = recoverIndex(unreadableText, empty, empty);
		expect(result.droppedLines).toBe(1);
	});

	it('an unreadable note that cannot even be located still recovers from memory and backup', () => {
		const memory = buildIndex([['A', ['a.md']]]);
		const backup = buildIndex([['B', ['b.md']]]);
		const result = recoverIndex('no fence here', memory, backup);
		expect(result.droppedLines).toBe(0);
		expectIndexEqual(result.index, buildIndex([['A', ['a.md']], ['B', ['b.md']]]));
	});

	it('all three sources empty -> an empty recovered index (the caller is the one that must refuse to write it)', () => {
		const result = recoverIndex('', empty, empty);
		expect(result.index.size).toBe(0);
		expect(result.droppedLines).toBe(0);
	});
});
