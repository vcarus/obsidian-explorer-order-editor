/**
 * End-to-end shape checks across the two pure layers.
 *
 * sortspec.test.ts and frontmatter.test.ts each cover their own module. This
 * file covers the seam: that what actually lands on disk is a file custom-sort
 * can read, and that merging into a hand-written file preserves it verbatim.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseSortingSpec, readFolderOrder, serializeSortingSpec, upsertFolderOrder } from '../src/sortspec';
import { readSortingSpecValue, replaceSortingSpecInFile } from '../src/frontmatter';
import type { Entry } from '../src/types';

const deps = { parseYaml };

function write(raw: string, target: string, specFolder: string, entries: readonly Entry[]): string {
	const read = readSortingSpecValue(raw, deps);
	const spec = parseSortingSpec(read.status === 'ok' ? read.value : '', specFolder);
	const result = upsertFolderOrder(spec, target, entries);
	return replaceSortingSpecInFile(raw, serializeSortingSpec(result.spec), deps);
}

describe('integration: generated sortspec.md', () => {
	it('parses back as the string scalar custom-sort requires', () => {
		const entries: Entry[] = [
			{ name: 'folder1', kind: 'folder' },
			{ name: 'folder2', kind: 'folder' },
			{ name: 'Untitled.base', kind: 'file' },
			{ name: 'Welcome', kind: 'file' },
		];
		const file = write('', '.', '/', entries);

		// custom-sort reads the PARSED frontmatter value and skips the file
		// entirely unless it is a string.
		const fm = parseYaml(file.split('---')[1]!) as Record<string, unknown>;
		expect(typeof fm['sorting-spec']).toBe('string');

		const lines = (fm['sorting-spec'] as string).split('\n').filter((l) => l.trim() !== '');
		expect(lines).toEqual([
			'target-folder: .',
			'// explorer-order-editor',
			'folder1',
			'folder2',
			// non-markdown files keep their extension, .md notes do not
			'Untitled.base',
			'Welcome',
		]);
	});

	it('is byte-identical when the same order is written twice', () => {
		const entries: Entry[] = [
			{ name: 'a', kind: 'folder' },
			{ name: 'b', kind: 'file' },
		];
		const once = write('', '.', '/', entries);
		expect(write(once, '.', '/', entries)).toBe(once);
	});

	it('leaves a hand-written section, its indented instructions, other keys and the body untouched', () => {
		const existing = [
			'---',
			'title: my notes',
			'sorting-spec: |',
			'  target-folder: Archive',
			'  // hand written',
			'  Zed',
			'    > a-z',
			'---',
			'body text',
			'',
		].join('\n');

		const out = write(existing, '.', 'Notes', [{ name: 'x', kind: 'file' }]);

		expect(out).toContain('  target-folder: Archive\n  // hand written\n  Zed\n    > a-z\n');
		expect(out).toContain('title: my notes');
		expect(out).toContain('body text');
		expect(out).toContain('  target-folder: .\n  // explorer-order-editor\n  x\n');
	});

	it('restores a saved order through a full disk round trip, and re-saving is a no-op', () => {
		// Deliberately not alphabetical: this is the case where falling back to
		// the default ordering would silently destroy what the user arranged.
		const saved: Entry[] = [
			{ name: 'Zebra', kind: 'file' },
			{ name: 'beta', kind: 'folder' },
			{ name: 'Apple', kind: 'file' },
			{ name: 'alpha', kind: 'folder' },
		];
		const file = write('', '.', 'Notes', saved);

		const read = readSortingSpecValue(file, deps);
		expect(read.status).toBe('ok');
		const spec = parseSortingSpec(read.status === 'ok' ? read.value : '', 'Notes');

		expect(readFolderOrder(spec, '.', saved)).toEqual(saved);
		expect(write(file, '.', 'Notes', saved)).toBe(file);
	});
});
