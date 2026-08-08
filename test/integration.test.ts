/**
 * End-to-end shape checks across the two pure layers.
 *
 * sortspec.test.ts and frontmatter.test.ts each cover their own module. This
 * file covers the seam: that clearing an authored order cascades correctly
 * through actual front-matter text (key -> block -> whole file), and that a
 * foreign (non-authored) section is never touched by it.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseSortingSpec, removeFolderOrder, serializeSortingSpec } from '../src/sortspec';
import { readSortingSpecValue, removeSortingSpecFromFile, replaceSortingSpecInFile } from '../src/frontmatter';

const deps = { parseYaml };

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

describe('integration: clearing a folder cascades key -> block -> whole file', () => {
	it('clearing one of several sections drops only that section, keeping the key and its siblings', () => {
		// Two independent authored sections, in the exact shape the (retired)
		// encoder used to produce: one for a different folder ("Elsewhere", an
		// explicit path unaffected by specFolder), one for this folder ("."
		// within "Archive", which resolves to "Archive").
		const file = [
			'---',
			'sorting-spec: |',
			'  target-folder: Elsewhere',
			'  // explorer-order-editor',
			'  Old',
			'  target-folder: .',
			'  // explorer-order-editor',
			'  New',
			'---',
			'',
		].join('\n');

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
		const withOrder = ['---', 'sorting-spec: |', '  target-folder: .', '  // explorer-order-editor', '  A', '---', ''].join('\n');
		expect(clear(withOrder, '.', 'Notes')).toBe('');
	});

	it('a foreign (non-authored) section for the same folder is never touched by clear', () => {
		const foreign = 'target-folder: .\nHand-written, no marker\n';
		expect(clear(foreign, '.', 'Notes')).toBe(foreign);
	});
});
