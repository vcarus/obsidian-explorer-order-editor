import { describe, expect, it } from 'vitest';
import { breadcrumbSegments, folderShortName, isSameOrder, navigationLabel, openingRowOrder } from '../src/navigation';
import type { Entry } from '../src/types';

const file = (name: string): Entry => ({ name, kind: 'file' });
const folder = (name: string): Entry => ({ name, kind: 'folder' });

describe('openingRowOrder', () => {
	it('follows the explorer names when they could be read', () => {
		const siblings = [file('a.md'), file('b.md'), folder('C')];
		expect(openingRowOrder(['b.md', 'C', 'a.md'], undefined, siblings)).toEqual([file('b.md'), folder('C'), file('a.md')]);
	});

	it('skips names with no matching sibling instead of inventing rows', () => {
		// The index note is the everyday such name: the explorer renders it,
		// the dialog's siblings never include it.
		const siblings = [file('a.md'), file('b.md')];
		expect(openingRowOrder(['b.md', 'explorer-order.md', 'a.md'], undefined, siblings)).toEqual([file('b.md'), file('a.md')]);
	});

	it('appends siblings the explorer never mentioned, in the order they arrived', () => {
		const siblings = [file('stale-2.md'), file('a.md'), file('stale-1.md')];
		expect(openingRowOrder(['a.md'], undefined, siblings)).toEqual([file('a.md'), file('stale-2.md'), file('stale-1.md')]);
	});

	it('a duplicated name keeps its first occurrence only', () => {
		const siblings = [file('a.md'), file('b.md')];
		expect(openingRowOrder(['a.md', 'b.md', 'a.md'], undefined, siblings)).toEqual([file('a.md'), file('b.md')]);
	});

	it('falls back to the stored order when the explorer could not be consulted', () => {
		const siblings = [file('a.md'), file('b.md'), file('c.md')];
		// The stored order names one gone entry (dropped) and two live ones;
		// the sibling it never mentioned lands at the end.
		expect(openingRowOrder(null, ['c.md', 'gone.md', 'a.md'], siblings)).toEqual([file('c.md'), file('a.md'), file('b.md')]);
	});

	it('no explorer and no stored order passes the siblings through unchanged', () => {
		const siblings = [file('b.md'), file('a.md')];
		expect(openingRowOrder(null, undefined, siblings)).toEqual([file('b.md'), file('a.md')]);
	});

	it('permutes the very objects it was handed rather than rebuilding them', () => {
		const a = file('a.md');
		const b = file('b.md');
		const out = openingRowOrder(['b.md', 'a.md'], undefined, [a, b]);
		expect(out[0]).toBe(b);
		expect(out[1]).toBe(a);
	});
});

describe('isSameOrder', () => {
	it('equal lists -> true', () => {
		expect(isSameOrder([folder('Archive'), file('Welcome')], [folder('Archive'), file('Welcome')])).toBe(true);
	});

	it('different length -> false', () => {
		expect(isSameOrder([folder('Archive'), file('Welcome')], [folder('Archive')])).toBe(false);
	});

	it('same names in a different order -> false', () => {
		expect(isSameOrder([folder('Archive'), file('Welcome')], [file('Welcome'), folder('Archive')])).toBe(false);
	});

	it('same name but different kind -> false', () => {
		expect(isSameOrder([file('Notes')], [folder('Notes')])).toBe(false);
	});

	it('two empty lists -> true', () => {
		expect(isSameOrder([], [])).toBe(true);
	});
});

describe('folderShortName', () => {
	it('root with a vault name -> the vault name', () => {
		expect(folderShortName('2026', true, 'My vault')).toBe('My vault');
	});

	it('root with an empty vault name -> "Vault root"', () => {
		expect(folderShortName('2026', true, '')).toBe('Vault root');
	});

	it('a nested folder -> its own name, not its path', () => {
		expect(folderShortName('2026', false, 'My vault')).toBe('2026');
	});
});

describe('navigationLabel', () => {
	it('dirty -> "Save and open" phrasing', () => {
		expect(navigationLabel(true, 'Projects')).toBe('Save and open "Projects"');
	});

	it('clean -> "Open" phrasing', () => {
		expect(navigationLabel(false, 'Projects')).toBe('Open "Projects"');
	});

	it('a target name containing a quote character is passed through verbatim', () => {
		expect(navigationLabel(false, 'Bob\'s "notes"')).toBe('Open "Bob\'s "notes""');
		expect(navigationLabel(true, 'Bob\'s "notes"')).toBe('Save and open "Bob\'s "notes""');
	});
});

describe('breadcrumbSegments', () => {
	it('count of 0 -> empty', () => {
		expect(breadcrumbSegments(0, 4)).toEqual([]);
	});

	it('count of 1 -> a single crumb, no ellipsis', () => {
		expect(breadcrumbSegments(1, 4)).toEqual([{ kind: 'crumb', index: 0 }]);
	});

	it('exactly at the limit -> every index, no ellipsis', () => {
		expect(breadcrumbSegments(4, 4)).toEqual([
			{ kind: 'crumb', index: 0 },
			{ kind: 'crumb', index: 1 },
			{ kind: 'crumb', index: 2 },
			{ kind: 'crumb', index: 3 },
		]);
	});

	it('one over the limit -> rendered length stays at maxVisible, so two indices collapse into the ellipsis', () => {
		const segments = breadcrumbSegments(5, 4);
		expect(segments).toEqual([
			{ kind: 'crumb', index: 0 },
			{ kind: 'ellipsis', hiddenIndices: [1, 2] },
			{ kind: 'crumb', index: 3 },
			{ kind: 'crumb', index: 4 },
		]);
		expect(segments).toHaveLength(4);
	});

	it('worked example: count = 6, maxVisible = 4', () => {
		expect(breadcrumbSegments(6, 4)).toEqual([
			{ kind: 'crumb', index: 0 },
			{ kind: 'ellipsis', hiddenIndices: [1, 2, 3] },
			{ kind: 'crumb', index: 4 },
			{ kind: 'crumb', index: 5 },
		]);
	});

	it('maxVisible of 2 clamps to 3', () => {
		const segments = breadcrumbSegments(6, 2);
		expect(segments).toEqual([
			{ kind: 'crumb', index: 0 },
			{ kind: 'ellipsis', hiddenIndices: [1, 2, 3, 4] },
			{ kind: 'crumb', index: 5 },
		]);
		expect(segments).toHaveLength(3);
	});

	it('whenever truncation happens, hiddenIndices is exactly the gap between the neighbouring crumbs', () => {
		for (const [count, maxVisible] of [
			[5, 4],
			[6, 4],
			[10, 4],
			[8, 5],
		] as const) {
			const segments = breadcrumbSegments(count, maxVisible);
			expect(segments).toHaveLength(Math.max(maxVisible, 3));

			const ellipsis = segments.find((s): s is { kind: 'ellipsis'; hiddenIndices: readonly number[] } => s.kind === 'ellipsis');
			expect(ellipsis).toBeDefined();

			const crumbIndices = segments
				.filter((s): s is { kind: 'crumb'; index: number } => s.kind === 'crumb')
				.map((s) => s.index);
			const before = crumbIndices[0];
			const after = crumbIndices[1];
			expect(before).toBeDefined();
			expect(after).toBeDefined();

			// Every index strictly between the two crumbs bracketing the
			// ellipsis is hidden, and nothing else is: no index rendered *and*
			// hidden, none dropped entirely.
			const expectedHidden = [];
			for (let index = (before ?? 0) + 1; index < (after ?? 0); index++) expectedHidden.push(index);
			expect(ellipsis?.hiddenIndices).toEqual(expectedHidden);

			const allIndices = [...crumbIndices, ...(ellipsis?.hiddenIndices ?? [])].sort((a, b) => a - b);
			expect(allIndices).toEqual(Array.from({ length: count }, (_, i) => i));
		}
	});
});
