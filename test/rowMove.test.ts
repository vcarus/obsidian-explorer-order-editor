import { describe, expect, it } from 'vitest';
import { moveNameInOrder } from '../src/rowMove';

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
