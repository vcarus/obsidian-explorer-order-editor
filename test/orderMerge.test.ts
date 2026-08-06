import { describe, expect, it } from 'vitest';
import { mergeStoredOrder } from '../src/sortspec';
import type { Entry } from '../src/types';

const file = (name: string): Entry => ({ name, kind: 'file' });
const folder = (name: string): Entry => ({ name, kind: 'folder' });

describe('mergeStoredOrder', () => {
	it('no stored order (null) -> the fallback order, unchanged', () => {
		const siblings = [folder('Projects'), folder('Archive'), file('Welcome')];
		expect(mergeStoredOrder(null, siblings)).toEqual(siblings);
	});

	it('every stored entry still exists -> keeps the stored order verbatim', () => {
		const siblings = [folder('Archive'), folder('Projects'), file('Welcome'), file('Todo')];
		const stored = [file('Todo'), folder('Projects'), file('Welcome'), folder('Archive')];
		expect(mergeStoredOrder(stored, siblings)).toEqual(stored);
	});

	it('a stored entry with no matching sibling is dropped', () => {
		const siblings = [folder('Archive'), file('Welcome')];
		const stored = [file('Deleted note'), folder('Archive'), file('Welcome')];
		expect(mergeStoredOrder(stored, siblings)).toEqual([folder('Archive'), file('Welcome')]);
	});

	it('a live sibling not mentioned in the stored order is appended afterwards, in fallback order', () => {
		const siblings = [folder('Archive'), folder('New folder'), file('Todo'), file('Welcome')];
		const stored = [file('Welcome'), folder('Archive')];
		expect(mergeStoredOrder(stored, siblings)).toEqual([
			file('Welcome'),
			folder('Archive'),
			// remaining siblings, in their own (folders-first, alphabetical) order
			folder('New folder'),
			file('Todo'),
		]);
	});

	it('identity is (kind, name): a file and a folder sharing a name are not confused', () => {
		const siblings = [file('Notes'), folder('Notes')];
		const stored = [folder('Notes'), file('Notes')];
		expect(mergeStoredOrder(stored, siblings)).toEqual([folder('Notes'), file('Notes')]);
	});

	it('a stale stored entry does not shadow a live sibling of the other kind with the same name', () => {
		// Stored order only knew about the file "Notes" (the folder was
		// created later). The file entry must be positioned per the stored
		// order; the new folder is appended afterwards.
		const siblings = [file('Notes'), folder('Notes')];
		const stored = [file('Notes')];
		expect(mergeStoredOrder(stored, siblings)).toEqual([file('Notes'), folder('Notes')]);
	});

	it('a duplicate within the stored order itself is deduped, keeping the first occurrence position', () => {
		const siblings = [file('A'), file('B')];
		const stored = [file('A'), file('B'), file('A')];
		expect(mergeStoredOrder(stored, siblings)).toEqual([file('A'), file('B')]);
	});

	it('empty stored order -> the full fallback order', () => {
		const siblings = [folder('Archive'), file('Welcome')];
		expect(mergeStoredOrder([], siblings)).toEqual(siblings);
	});

	it('empty siblings -> empty result regardless of what was stored', () => {
		expect(mergeStoredOrder([file('Gone')], [])).toEqual([]);
	});
});
