import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { FrontMatterError, readSortingSpecValue, removeSortingSpecFromFile, replaceSortingSpecInFile, type FrontMatterDeps } from '../src/frontmatter';

const deps: FrontMatterDeps = { parseYaml };

// ---------------------------------------------------------------------------
// readSortingSpecValue — semantic view
//
// Also the only remaining coverage of the internal `locateFrontMatter`
// helper these (and `replaceSortingSpecInFile`/`removeSortingSpecFromFile`
// below) are built on: that function is no longer exported, and every case
// it distinguishes was already redundant with a test here or below — an
// empty file, a plain note with no `---`, and an unclosed opening `---` all
// already had their own `readSortingSpecValue` case (`no-frontmatter`), and
// a leading BOM being stripped and correctly reproduced is what
// `replaceSortingSpecInFile`'s "preserves a leading BOM" case (further down)
// actually verifies — more strongly than checking the parsed position alone
// would, since it round-trips through a real write.
// ---------------------------------------------------------------------------

describe('readSortingSpecValue', () => {
	it('missing/empty file -> no-frontmatter', () => {
		expect(readSortingSpecValue('', deps)).toEqual({ status: 'no-frontmatter' });
	});

	it('no front matter at all -> no-frontmatter', () => {
		expect(readSortingSpecValue('just a note', deps)).toEqual({ status: 'no-frontmatter' });
	});

	it('unclosed opening --- -> no-frontmatter', () => {
		expect(readSortingSpecValue('---\nfoo: bar\nnot closed', deps).status).toBe('no-frontmatter');
	});

	it('front matter with no sorting-spec key -> absent', () => {
		expect(readSortingSpecValue('---\nfoo: bar\n---\nbody', deps)).toEqual({ status: 'absent' });
	});

	it('empty front matter -> absent', () => {
		expect(readSortingSpecValue('---\n---\nbody', deps)).toEqual({ status: 'absent' });
	});

	it('non-string value -> non-string', () => {
		expect(readSortingSpecValue('---\nsorting-spec: 5\n---\n', deps)).toEqual({ status: 'non-string' });
		expect(readSortingSpecValue('---\nsorting-spec:\n  - a\n  - b\n---\n', deps).status).toBe('non-string');
	});

	it('invalid YAML -> invalid-yaml', () => {
		expect(readSortingSpecValue('---\nfoo: [unclosed\n---\n', deps)).toEqual({ status: 'invalid-yaml' });
	});

	it('string value -> ok, exactly as YAML parses it (block scalar clip keeps one trailing newline)', () => {
		const raw = '---\nsorting-spec: |\n  target-folder: .\n  Item\n---\nbody';
		expect(readSortingSpecValue(raw, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nItem\n' });
	});

	it('CRLF front matter reads the same value as LF', () => {
		const raw = '---\r\nsorting-spec: |\r\n  target-folder: .\r\n  Item\r\n---\r\nbody\r\n';
		expect(readSortingSpecValue(raw, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nItem\n' });
	});
});

// ---------------------------------------------------------------------------
// replaceSortingSpecInFile
// ---------------------------------------------------------------------------

describe('replaceSortingSpecInFile: creating front matter', () => {
	it('missing/empty file -> creates a fresh front matter block', () => {
		const result = replaceSortingSpecInFile('', 'target-folder: .\nA\nB', deps);
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nA\nB\n' });
	});

	it('note with no front matter -> prepends a block, note body untouched byte-for-byte', () => {
		const body = 'Just a note.\nSecond line.\n';
		const result = replaceSortingSpecInFile(body, 'target-folder: .\nX', deps);
		expect(result.endsWith(body)).toBe(true);
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nX\n' });
	});

	it('front matter with no sorting-spec key -> adds it, preserving other keys and the body', () => {
		const raw = '---\ntitle: Hello\ntags:\n  - a\n  - b\n---\nBody text\nmore body\n';
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nX', deps);
		expect(result).toContain('title: Hello');
		expect(result).toContain('Body text\nmore body\n');
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nX\n' });
	});

	it('empty front matter -> adds the key', () => {
		const result = replaceSortingSpecInFile('---\n---\nBody\n', 'target-folder: .\nX', deps);
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nX\n' });
		expect(result).toContain('Body\n');
	});
});

describe('replaceSortingSpecInFile: replacing an existing value', () => {
	it('replaces a block-scalar value in place, preserving other keys', () => {
		const raw = '---\ntitle: Hello\nsorting-spec: |\n  target-folder: .\n  Old\ncount: 3\n---\nBody\n';
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nNew1\nNew2', deps);
		expect(result).toContain('title: Hello');
		expect(result).toContain('count: 3');
		expect(result).not.toContain('Old');
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nNew1\nNew2\n' });
	});

	it('splice trap: an indent-0 YAML list value (silently ignored by custom-sort) is replaced wholesale', () => {
		const raw = '---\ntitle: T\nsorting-spec:\n- foo\n- bar\nother: 1\n---\nBody\n';
		expect(readSortingSpecValue(raw, deps).status).toBe('non-string');
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nZ', deps);
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nZ\n' });
		expect(result).toContain('other: 1');
		expect(result).not.toContain('foo');
	});

	it('replaces a nested-mapping-shaped value', () => {
		const raw = '---\nsorting-spec:\n  weird: yes\n  shape: true\nother: 1\n---\nBody\n';
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nZ', deps);
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nZ\n' });
		expect(result).toContain('other: 1');
	});

	it('replaces a flow-collection-shaped value', () => {
		const raw = '---\nsorting-spec: [a, b]\nother: 1\n---\nBody\n';
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nZ', deps);
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nZ\n' });
		expect(result).toContain('other: 1');
	});

	it('replaces a quoted scalar value', () => {
		const raw = '---\nsorting-spec: "old value"\nother: 1\n---\nBody\n';
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nZ', deps);
		expect(readSortingSpecValue(result, deps)).toEqual({ status: 'ok', value: 'target-folder: .\nZ\n' });
		expect(result).toContain('other: 1');
	});

	it('preserves a same-line trailing comment on the key', () => {
		const raw = '---\nsorting-spec: | # keep me\n  target-folder: .\n  Old\n---\n';
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nNew', deps);
		expect(result).toContain('sorting-spec: | # keep me');
	});

	it('preserves CRLF line endings for every untouched line', () => {
		const raw = '---\r\ntitle: T\r\nsorting-spec: |\r\n  target-folder: .\r\n  Old\r\n---\r\nBody\r\n';
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nNew', deps);
		expect(result).toContain('title: T\r\n');
		expect(result).toContain('Body\r\n');
		expect(result.match(/\r\n/g)?.length).toBe(result.split('\n').length - 1); // every line break is CRLF, none bare LF
	});

	it('preserves a leading BOM', () => {
		const raw = '﻿---\nsorting-spec: |\n  target-folder: .\n  Old\n---\n';
		const result = replaceSortingSpecInFile(raw, 'target-folder: .\nNew', deps);
		expect(result.startsWith('﻿')).toBe(true);
	});

	it('running the identical replace twice produces byte-identical output', () => {
		const raw = '---\ntitle: T\n---\nBody\n';
		const once = replaceSortingSpecInFile(raw, 'target-folder: .\nA', deps);
		const twice = replaceSortingSpecInFile(once, 'target-folder: .\nA', deps);
		expect(twice).toBe(once);
	});
});

describe('replaceSortingSpecInFile: error cases', () => {
	it('two top-level sorting-spec keys -> throws duplicate-key, even if the injected parser tolerates it', () => {
		const raw = '---\nsorting-spec: foo\nsorting-spec: bar\n---\n';
		const tolerant: FrontMatterDeps = { parseYaml: () => ({ 'sorting-spec': 'bar' }) };
		expect(() => replaceSortingSpecInFile(raw, 'x', tolerant)).toThrow(FrontMatterError);
		try {
			replaceSortingSpecInFile(raw, 'x', tolerant);
		} catch (e) {
			expect(e).toBeInstanceOf(FrontMatterError);
			expect((e as FrontMatterError).code).toBe('duplicate-key');
		}
	});

	it('invalid YAML -> throws invalid-yaml', () => {
		const raw = '---\nfoo: [unclosed\n---\n';
		expect(() => replaceSortingSpecInFile(raw, 'x', deps)).toThrow(FrontMatterError);
		try {
			replaceSortingSpecInFile(raw, 'x', deps);
		} catch (e) {
			expect((e as FrontMatterError).code).toBe('invalid-yaml');
		}
	});

	it('semantic says a value exists but the syntactic scanner finds no range -> unsupported-shape', () => {
		const raw = '---\ntitle: T\n---\nBody\n';
		const lying: FrontMatterDeps = { parseYaml: () => ({ title: 'T', 'sorting-spec': 'phantom' }) };
		expect(() => replaceSortingSpecInFile(raw, 'x', lying)).toThrow(FrontMatterError);
		try {
			replaceSortingSpecInFile(raw, 'x', lying);
		} catch (e) {
			expect((e as FrontMatterError).code).toBe('unsupported-shape');
		}
	});

	it('semantic says absent but the syntactic scanner finds a key -> unsupported-shape', () => {
		const raw = '---\nsorting-spec: real\n---\nBody\n';
		const blind: FrontMatterDeps = { parseYaml: () => ({}) };
		expect(() => replaceSortingSpecInFile(raw, 'x', blind)).toThrow(FrontMatterError);
		try {
			replaceSortingSpecInFile(raw, 'x', blind);
		} catch (e) {
			expect((e as FrontMatterError).code).toBe('unsupported-shape');
		}
	});

	it('verification failure (parser disagrees with itself between write and re-read) -> verification-failed, and throws rather than returning corrupt text', () => {
		let call = 0;
		const flaky: FrontMatterDeps = {
			parseYaml: (source: string): unknown => {
				call += 1;
				// First call (initial read) behaves normally; later calls (post-write
				// verification) claim the key is missing, simulating an unanticipated
				// parser edge case.
				if (call === 1) return parseYaml(source) as unknown;
				return {};
			},
		};
		expect(() => replaceSortingSpecInFile('---\ntitle: T\n---\nBody\n', 'target-folder: .\nA', flaky)).toThrow(FrontMatterError);
	});
});

// ---------------------------------------------------------------------------
// removeSortingSpecFromFile
// ---------------------------------------------------------------------------

describe('removeSortingSpecFromFile', () => {
	it('no-op on an empty file', () => {
		expect(removeSortingSpecFromFile('', deps)).toBe('');
	});

	it('no-op when there is no front matter', () => {
		expect(removeSortingSpecFromFile('plain note', deps)).toBe('plain note');
	});

	it('no-op when the key is absent', () => {
		const raw = '---\ntitle: T\n---\nBody';
		expect(removeSortingSpecFromFile(raw, deps)).toBe(raw);
	});

	it('removes the key, keeping other keys and the body', () => {
		const raw = '---\ntitle: Hello\nsorting-spec: |\n  target-folder: .\n  X\ncount: 2\n---\nBody\n';
		const result = removeSortingSpecFromFile(raw, deps);
		expect(readSortingSpecValue(result, deps).status).toBe('absent');
		expect(result).toContain('title: Hello');
		expect(result).toContain('count: 2');
		expect(result).toContain('Body\n');
	});

	it('deletes the whole front matter block once it becomes whitespace-only', () => {
		const raw = '---\nsorting-spec: |\n  target-folder: .\n  X\n---\nBody text\n';
		const result = removeSortingSpecFromFile(raw, deps);
		expect(result).not.toContain('---');
		expect(result).toContain('Body text');
	});

	it('returns an empty string when the whole file becomes empty', () => {
		const raw = '---\nsorting-spec: |\n  target-folder: .\n  X\n---\n';
		expect(removeSortingSpecFromFile(raw, deps)).toBe('');
	});

	it('two top-level sorting-spec keys -> throws duplicate-key', () => {
		const raw = '---\nsorting-spec: foo\nsorting-spec: bar\n---\n';
		const tolerant: FrontMatterDeps = { parseYaml: () => ({ 'sorting-spec': 'bar' }) };
		expect(() => removeSortingSpecFromFile(raw, tolerant)).toThrow(FrontMatterError);
	});

	it('running remove on an already-removed file is idempotent', () => {
		const raw = '---\ntitle: Hello\nsorting-spec: |\n  target-folder: .\n  X\n---\nBody\n';
		const once = removeSortingSpecFromFile(raw, deps);
		const twice = removeSortingSpecFromFile(once, deps);
		expect(twice).toBe(once);
	});
});
