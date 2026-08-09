import { describe, expect, it } from 'vitest';
import { SORT_CHOICES, sortEntries, type SortableEntry, type SortKey } from '../src/entrySort';
import { fallbackEntryOrder } from '../src/types';

const file = (name: string, ctime: number | null = null, mtime: number | null = null): SortableEntry => ({
	name,
	kind: 'file',
	ctime,
	mtime,
});
const folder = (name: string): SortableEntry => ({ name, kind: 'folder', ctime: null, mtime: null });

describe('SORT_CHOICES', () => {
	it('has exactly six entries, one per (key, descending) combination', () => {
		expect(SORT_CHOICES).toHaveLength(6);

		const keys: readonly SortKey[] = ['name', 'created', 'modified'];
		for (const key of keys) {
			for (const descending of [false, true]) {
				expect(SORT_CHOICES.filter((c) => c.key === key && c.descending === descending)).toHaveLength(1);
			}
		}
	});

	it('has unique ids', () => {
		const ids = SORT_CHOICES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('has the exact ids, labels, keys and directions specified for the dialog', () => {
		expect(SORT_CHOICES).toEqual([
			{ id: 'name-asc', label: 'Name (A to Z)', key: 'name', descending: false },
			{ id: 'name-desc', label: 'Name (Z to A)', key: 'name', descending: true },
			{ id: 'created-desc', label: 'Created (newest first)', key: 'created', descending: true },
			{ id: 'created-asc', label: 'Created (oldest first)', key: 'created', descending: false },
			{ id: 'modified-desc', label: 'Modified (newest first)', key: 'modified', descending: true },
			{ id: 'modified-asc', label: 'Modified (oldest first)', key: 'modified', descending: false },
		]);
	});
});

describe('sortEntries', () => {
	// A folder and file fixture with distinct, non-overlapping ctime/mtime
	// values so every one of the six choices produces a distinguishable order.
	const fixture: readonly SortableEntry[] = [
		folder('Zeta'),
		folder('Alpha'),
		file('banana.md', 20, 200),
		file('apple.md', 30, 100),
		file('cherry.md', 10, 300),
	];

	it('name-asc: folders by name, then files by name, both ascending', () => {
		const choice = SORT_CHOICES.find((c) => c.id === 'name-asc');
		if (!choice) throw new Error('name-asc missing from SORT_CHOICES');
		expect(sortEntries(fixture, choice.key, choice.descending)).toEqual([
			folder('Alpha'),
			folder('Zeta'),
			file('apple.md', 30, 100),
			file('banana.md', 20, 200),
			file('cherry.md', 10, 300),
		]);
	});

	it('name-desc: folders by name descending, then files by name descending', () => {
		const choice = SORT_CHOICES.find((c) => c.id === 'name-desc');
		if (!choice) throw new Error('name-desc missing from SORT_CHOICES');
		expect(sortEntries(fixture, choice.key, choice.descending)).toEqual([
			folder('Zeta'),
			folder('Alpha'),
			file('cherry.md', 10, 300),
			file('banana.md', 20, 200),
			file('apple.md', 30, 100),
		]);
	});

	it('created-desc: folders by name ascending (direction is meaningless for them), files newest ctime first', () => {
		const choice = SORT_CHOICES.find((c) => c.id === 'created-desc');
		if (!choice) throw new Error('created-desc missing from SORT_CHOICES');
		expect(sortEntries(fixture, choice.key, choice.descending)).toEqual([
			folder('Alpha'),
			folder('Zeta'),
			file('apple.md', 30, 100),
			file('banana.md', 20, 200),
			file('cherry.md', 10, 300),
		]);
	});

	it('created-asc: folders by name ascending, files oldest ctime first', () => {
		const choice = SORT_CHOICES.find((c) => c.id === 'created-asc');
		if (!choice) throw new Error('created-asc missing from SORT_CHOICES');
		expect(sortEntries(fixture, choice.key, choice.descending)).toEqual([
			folder('Alpha'),
			folder('Zeta'),
			file('cherry.md', 10, 300),
			file('banana.md', 20, 200),
			file('apple.md', 30, 100),
		]);
	});

	it('modified-desc: folders by name ascending, files newest mtime first', () => {
		const choice = SORT_CHOICES.find((c) => c.id === 'modified-desc');
		if (!choice) throw new Error('modified-desc missing from SORT_CHOICES');
		expect(sortEntries(fixture, choice.key, choice.descending)).toEqual([
			folder('Alpha'),
			folder('Zeta'),
			file('cherry.md', 10, 300),
			file('banana.md', 20, 200),
			file('apple.md', 30, 100),
		]);
	});

	it('modified-asc: folders by name ascending, files oldest mtime first', () => {
		const choice = SORT_CHOICES.find((c) => c.id === 'modified-asc');
		if (!choice) throw new Error('modified-asc missing from SORT_CHOICES');
		expect(sortEntries(fixture, choice.key, choice.descending)).toEqual([
			folder('Alpha'),
			folder('Zeta'),
			file('apple.md', 30, 100),
			file('banana.md', 20, 200),
			file('cherry.md', 10, 300),
		]);
	});

	it('folders precede files under every one of the six choices', () => {
		for (const choice of SORT_CHOICES) {
			const result = sortEntries(fixture, choice.key, choice.descending);
			const firstFileIndex = result.findIndex((e) => e.kind === 'file');
			const lastFolderIndex = result.map((e) => e.kind).lastIndexOf('folder');
			expect(lastFolderIndex).toBeLessThan(firstFileIndex);
		}
	});

	it('under created/modified, folders are ordered by name ascending regardless of descending', () => {
		const folders = [folder('Zeta'), folder('Alpha'), folder('Mid')];
		for (const key of ['created', 'modified'] as const) {
			for (const descending of [false, true]) {
				const result = sortEntries(folders, key, descending);
				expect(result.map((e) => e.name)).toEqual(['Alpha', 'Mid', 'Zeta']);
			}
		}
	});

	it('equal timestamps fall through to name, deterministically', () => {
		const entries = [file('banana.md', 5, 5), file('apple.md', 5, 5), file('cherry.md', 5, 5)];
		expect(sortEntries(entries, 'created', false).map((e) => e.name)).toEqual(['apple.md', 'banana.md', 'cherry.md']);
		expect(sortEntries(entries, 'created', true).map((e) => e.name)).toEqual(['apple.md', 'banana.md', 'cherry.md']);
	});

	it('equal timestamps and canonically-equivalent names fall through to the code-unit tiebreak, deterministically', () => {
		// See "The NFC/NFD problem" in entrySort.ts: localeCompare alone treats
		// these two names as equal, so without the code-unit fallback this
		// pair's relative order would depend on input order, not be fixed.
		const nfc = 'café.md'.normalize('NFC');
		const nfd = 'café.md'.normalize('NFD');
		expect(nfc).not.toBe(nfd);

		const entries = [file(nfd, 5, 5), file(nfc, 5, 5)];
		const result = sortEntries(entries, 'created', false);
		expect(result.map((e) => e.name)).toEqual(nfc < nfd ? [nfc, nfd] : [nfd, nfc]);
	});

	it('an NFC/NFD pair produces the same output regardless of input order, for all six choices', () => {
		const nfc = 'résumé.md'.normalize('NFC');
		const nfd = 'résumé.md'.normalize('NFD');
		expect(nfc).not.toBe(nfd);

		const a = file(nfc, 1, 1);
		const b = file(nfd, 1, 1);

		for (const choice of SORT_CHOICES) {
			const fromAB = sortEntries([a, b], choice.key, choice.descending).map((e) => e.name);
			const fromBA = sortEntries([b, a], choice.key, choice.descending).map((e) => e.name);
			expect(fromAB).toEqual(fromBA);
		}
	});

	it("sortEntries(entries, 'name', false) matches fallbackEntryOrder on the same fixture", () => {
		const plain = fixture.map(({ name, kind }) => ({ name, kind }));
		const sorted = sortEntries(fixture, 'name', false).map(({ name, kind }) => ({ name, kind }));
		expect(sorted).toEqual(fallbackEntryOrder(plain));
	});

	it('files with null ctime sort after files with a value, deterministically', () => {
		const entries = [file('b.md', null, 1), file('a.md', 5, 1), file('c.md', null, 1)];
		// 'a.md' has a value (5) and sorts first either direction; the two
		// null-ctime files fall through to name for their relative order.
		expect(sortEntries(entries, 'created', false).map((e) => e.name)).toEqual(['a.md', 'b.md', 'c.md']);
		expect(sortEntries(entries, 'created', true).map((e) => e.name)).toEqual(['a.md', 'b.md', 'c.md']);
	});

	it('files with null mtime sort after files with a value, deterministically', () => {
		const entries = [file('b.md', 1, null), file('a.md', 1, 5), file('c.md', 1, null)];
		expect(sortEntries(entries, 'modified', false).map((e) => e.name)).toEqual(['a.md', 'b.md', 'c.md']);
		expect(sortEntries(entries, 'modified', true).map((e) => e.name)).toEqual(['a.md', 'b.md', 'c.md']);
	});

	it('an empty list sorts to an empty list', () => {
		expect(sortEntries([], 'name', false)).toEqual([]);
	});

	it('a single entry is returned as-is', () => {
		expect(sortEntries([file('only.md', 1, 1)], 'modified', true)).toEqual([file('only.md', 1, 1)]);
	});

	it('does not mutate the input array', () => {
		const input = [file('b.md', 2, 2), file('a.md', 1, 1)];
		const snapshot = [...input];
		sortEntries(input, 'created', true);
		expect(input).toEqual(snapshot);
	});
});
