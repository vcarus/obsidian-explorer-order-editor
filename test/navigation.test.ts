import { describe, expect, it } from 'vitest';
import { breadcrumbSegments, folderShortName, isSameOrder, navigationLabel } from '../src/navigation';
import type { Entry } from '../src/types';

const file = (name: string): Entry => ({ name, kind: 'file' });
const folder = (name: string): Entry => ({ name, kind: 'folder' });

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
