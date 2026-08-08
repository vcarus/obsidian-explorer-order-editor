import { describe, expect, it } from 'vitest';
import { insertNameBeside, moveNameInOrder } from '../src/rowMove';

describe('moveNameInOrder', () => {
	// [a, b, c, d, e] — 'c' at index 2 is neither edge, so every move goes somewhere.
	const names = ['a', 'b', 'c', 'd', 'e'];

	it('up: swaps with its predecessor', () => {
		expect(moveNameInOrder(names, 'c', 'up')).toEqual(['a', 'c', 'b', 'd', 'e']);
	});

	it('down: swaps with its successor', () => {
		expect(moveNameInOrder(names, 'c', 'down')).toEqual(['a', 'b', 'd', 'c', 'e']);
	});

	it('top: moves to the front, preserving the relative order of everything else', () => {
		expect(moveNameInOrder(names, 'c', 'top')).toEqual(['c', 'a', 'b', 'd', 'e']);
	});

	it('bottom: moves to the end, preserving the relative order of everything else', () => {
		expect(moveNameInOrder(names, 'c', 'bottom')).toEqual(['a', 'b', 'd', 'e', 'c']);
	});

	it('up on the first entry is a no-op: null, already at that edge', () => {
		expect(moveNameInOrder(names, 'a', 'up')).toBeNull();
	});

	it('top on the first entry is a no-op: null, already there', () => {
		expect(moveNameInOrder(names, 'a', 'top')).toBeNull();
	});

	it('down on the last entry is a no-op: null, already at that edge', () => {
		expect(moveNameInOrder(names, 'e', 'down')).toBeNull();
	});

	it('bottom on the last entry is a no-op: null, already there', () => {
		expect(moveNameInOrder(names, 'e', 'bottom')).toBeNull();
	});

	it('a name absent from the list: null for every move', () => {
		expect(moveNameInOrder(names, 'nope', 'up')).toBeNull();
		expect(moveNameInOrder(names, 'nope', 'down')).toBeNull();
		expect(moveNameInOrder(names, 'nope', 'top')).toBeNull();
		expect(moveNameInOrder(names, 'nope', 'bottom')).toBeNull();
	});

	it('a single-entry list: null for every move, nothing to reorder against', () => {
		expect(moveNameInOrder(['only'], 'only', 'up')).toBeNull();
		expect(moveNameInOrder(['only'], 'only', 'down')).toBeNull();
		expect(moveNameInOrder(['only'], 'only', 'top')).toBeNull();
		expect(moveNameInOrder(['only'], 'only', 'bottom')).toBeNull();
	});

	it('an empty list: null for every move', () => {
		expect(moveNameInOrder([], 'anything', 'up')).toBeNull();
		expect(moveNameInOrder([], 'anything', 'bottom')).toBeNull();
	});

	it('never mutates the input array, on a real move or a no-op alike', () => {
		const input = ['a', 'b', 'c'];
		const snapshot = [...input];

		moveNameInOrder(input, 'b', 'up');
		expect(input).toEqual(snapshot);

		moveNameInOrder(input, 'a', 'up'); // no-op case
		expect(input).toEqual(snapshot);

		moveNameInOrder(input, 'missing', 'top'); // absent-name case
		expect(input).toEqual(snapshot);
	});

	it('count 2: down and bottom agree when starting at the top', () => {
		expect(moveNameInOrder(['a', 'b'], 'a', 'down')).toEqual(['b', 'a']);
		expect(moveNameInOrder(['a', 'b'], 'a', 'bottom')).toEqual(['b', 'a']);
	});

	it('count 2: up and top agree when starting at the bottom', () => {
		expect(moveNameInOrder(['a', 'b'], 'b', 'up')).toEqual(['b', 'a']);
		expect(moveNameInOrder(['a', 'b'], 'b', 'top')).toEqual(['b', 'a']);
	});
});

describe('insertNameBeside', () => {
	it('same-folder move down: strips before searching, so the classic off-by-one does not creep in', () => {
		// If anchor's index were read from the *original* array (before removing
		// 'a'), 'b' would still be seen at index 1 and 'after' would insert at
		// index 2 — landing 'a' after 'c' instead of after 'b'. Splicing 'a' out
		// first is what keeps this correct.
		expect(insertNameBeside(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
	});

	it('same-folder move up', () => {
		expect(insertNameBeside(['a', 'b', 'c'], 'c', 'b', 'before')).toEqual(['a', 'c', 'b']);
	});

	it('same-folder move to the far end, before the first entry', () => {
		expect(insertNameBeside(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
	});

	it('same-folder move to the far end, after the last entry', () => {
		expect(insertNameBeside(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
	});

	it('cross-folder insert: moved is not in names at all — the target folder has never heard of it', () => {
		expect(insertNameBeside(['x', 'y', 'z'], 'new', 'y', 'after')).toEqual(['x', 'y', 'new', 'z']);
		expect(insertNameBeside(['x', 'y', 'z'], 'new', 'y', 'before')).toEqual(['x', 'new', 'y', 'z']);
	});

	it('cross-folder insert beside the first or last entry', () => {
		expect(insertNameBeside(['x', 'y'], 'new', 'x', 'before')).toEqual(['new', 'x', 'y']);
		expect(insertNameBeside(['x', 'y'], 'new', 'y', 'after')).toEqual(['x', 'y', 'new']);
	});

	it('every occurrence of moved is stripped, not just the first, before the insert', () => {
		expect(insertNameBeside(['a', 'b', 'a', 'c'], 'a', 'c', 'before')).toEqual(['b', 'a', 'c']);
	});

	it('null: dropping right where it already is, before its current successor', () => {
		// ['a', 'b', 'c'] — 'a' is already immediately before 'b'.
		expect(insertNameBeside(['a', 'b', 'c'], 'a', 'b', 'before')).toBeNull();
	});

	it('null: dropping right where it already is, after its current predecessor', () => {
		// ['a', 'b', 'c'] — 'b' is already immediately after 'a'.
		expect(insertNameBeside(['a', 'b', 'c'], 'b', 'a', 'after')).toBeNull();
	});

	it('null: moved === anchor, a row cannot be dropped beside itself', () => {
		expect(insertNameBeside(['a', 'b', 'c'], 'b', 'b', 'before')).toBeNull();
		expect(insertNameBeside(['a', 'b', 'c'], 'b', 'b', 'after')).toBeNull();
	});

	it('null: moved === anchor even when neither is in names', () => {
		expect(insertNameBeside(['x', 'y'], 'nope', 'nope', 'before')).toBeNull();
	});

	it('null: anchor is not in names', () => {
		expect(insertNameBeside(['a', 'b', 'c'], 'a', 'nope', 'before')).toBeNull();
	});

	it('null: anchor is not in names, even for a cross-folder moved', () => {
		expect(insertNameBeside(['a', 'b', 'c'], 'new', 'nope', 'after')).toBeNull();
	});

	it('single-element array: moved is the only entry and equals anchor, null', () => {
		expect(insertNameBeside(['only'], 'only', 'only', 'before')).toBeNull();
	});

	it('single-element array: cross-folder insert beside the only entry', () => {
		expect(insertNameBeside(['only'], 'new', 'only', 'before')).toEqual(['new', 'only']);
		expect(insertNameBeside(['only'], 'new', 'only', 'after')).toEqual(['only', 'new']);
	});

	it('empty array: anchor can never be found, null', () => {
		expect(insertNameBeside([], 'a', 'b', 'before')).toBeNull();
		expect(insertNameBeside([], 'a', 'b', 'after')).toBeNull();
	});

	it('never mutates the input array, on a real move, a no-op, or a cross-folder insert alike', () => {
		const input = ['a', 'b', 'c'];
		const snapshot = [...input];

		insertNameBeside(input, 'a', 'c', 'after');
		expect(input).toEqual(snapshot);

		insertNameBeside(input, 'a', 'b', 'before'); // no-op case
		expect(input).toEqual(snapshot);

		insertNameBeside(input, 'new', 'b', 'after'); // cross-folder case
		expect(input).toEqual(snapshot);

		insertNameBeside(input, 'b', 'nope', 'after'); // anchor-missing case
		expect(input).toEqual(snapshot);
	});
});
