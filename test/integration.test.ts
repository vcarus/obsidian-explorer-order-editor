/**
 * End-to-end shape checks across the two pure layers.
 *
 * sortspec.test.ts and frontmatter.test.ts each cover their own module. This
 * file covers the seam: that what actually lands on disk is a file custom-sort
 * can read, and that merging into a hand-written file preserves it verbatim.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseSortingSpec, readFolderOrder, removeFolderOrder, serializeSortingSpec, upsertFolderOrder } from '../src/sortspec';
import { readSortingSpecValue, removeSortingSpecFromFile, replaceSortingSpecInFile } from '../src/frontmatter';
import type { Entry } from '../src/types';

const deps = { parseYaml };

function write(raw: string, target: string, specFolder: string, entries: readonly Entry[]): string {
	const read = readSortingSpecValue(raw, deps);
	const spec = parseSortingSpec(read.status === 'ok' ? read.value : '', specFolder);
	const result = upsertFolderOrder(spec, target, entries);
	return replaceSortingSpecInFile(raw, serializeSortingSpec(result.spec), deps);
}

/**
 * Mirrors `sortspecFile.ts`'s private `applyMutation`, specifically the
 * branch it takes for a `removeFolderOrder` result: when nothing is left to
 * say for the folder, drop the key (and cascade further, per
 * `removeSortingSpecFromFile`) instead of writing back an empty
 * `sorting-spec: |` block. `sortspecFile.ts` itself can't be unit tested
 * here — the `obsidian` package ships type declarations only, no runtime —
 * so this recomposes the same two pure functions it calls, to cover the
 * "clear explorer order" cascade (key -> block -> whole file) at the level
 * this test suite can reach.
 */
function clear(raw: string, target: string, specFolder: string): string {
	const read = readSortingSpecValue(raw, deps);
	const spec = parseSortingSpec(read.status === 'ok' ? read.value : '', specFolder);
	const result = removeFolderOrder(spec, target);
	if (result.status === 'blocked' || result.status === 'unchanged') return raw;
	const newValue = serializeSortingSpec(result.spec);
	return newValue === '' ? removeSortingSpecFromFile(raw, deps) : replaceSortingSpecInFile(raw, newValue, deps);
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

describe('integration: clearing a folder cascades key -> block -> whole file', () => {
	it('clearing one of several sections drops only that section, keeping the key and its siblings', () => {
		// Two independent sections: one for a different folder ("Elsewhere",
		// an explicit path unaffected by specFolder), one for this folder
		// ("." within "Archive", which resolves to "Archive").
		const file = write(write('', 'Elsewhere', '/', [{ name: 'Old', kind: 'file' }]), '.', 'Archive', [{ name: 'New', kind: 'file' }]);
		const cleared = clear(file, '.', 'Archive');
		expect(readSortingSpecValue(cleared, deps).status).toBe('ok');
		expect(cleared).toContain('target-folder: Elsewhere');
		expect(cleared).toContain('Old');
		expect(cleared).not.toContain('New');
	});

	it('clearing the only section drops the sorting-spec key, keeping other front matter keys and the body', () => {
		const withOrder = [
			'---',
			'title: My notes',
			'sorting-spec: |',
			'  target-folder: .',
			'  // explorer-order-editor',
			'  A',
			'---',
			'Some hand-written body text.',
			'',
		].join('\n');
		const cleared = clear(withOrder, '.', 'Notes');
		expect(readSortingSpecValue(cleared, deps).status).toBe('absent');
		expect(cleared).toContain('title: My notes');
		expect(cleared).toContain('Some hand-written body text.');
	});

	it('clearing a sortspec.md with nothing else in it empties the file entirely, ready to be trashed', () => {
		const withOrder = write('', '.', 'Notes', [{ name: 'A', kind: 'file' }]);
		expect(clear(withOrder, '.', 'Notes')).toBe('');
	});

	it('a foreign (non-authored) section for the same folder is never touched by clear', () => {
		const foreign = 'target-folder: .\nHand-written, no marker\n';
		expect(clear(foreign, '.', 'Notes')).toBe(foreign);
	});
});
