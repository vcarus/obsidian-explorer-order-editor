import { describe, expect, it } from 'vitest';
import {
	canonicalizeSortingSpec,
	hasAuthoredSection,
	normalizeTarget,
	parseSortingSpec,
	removeFolderOrder,
	serializeSortingSpec,
	specTargets,
} from '../src/sortspec';

// ---------------------------------------------------------------------------
// normalizeTarget / target kinds
// ---------------------------------------------------------------------------

describe('normalizeTarget', () => {
	it('classifies root, dot (resolved and unresolved), wildcard, dead, path, and empty', () => {
		expect(normalizeTarget('/', null)).toEqual({ kind: 'root', raw: '/', resolved: '/' });
		expect(normalizeTarget('.', 'Archive/Sub')).toEqual({ kind: 'dot', raw: '.', resolved: 'Archive/Sub' });
		expect(normalizeTarget('.', null)).toEqual({ kind: 'dot', raw: '.', resolved: null });
		expect(normalizeTarget('Foo/.../Bar', null)).toEqual({ kind: 'wildcard', raw: 'Foo/.../Bar', resolved: null });
		expect(normalizeTarget('/Projects', null)).toEqual({ kind: 'dead', raw: '/Projects', resolved: null });
		expect(normalizeTarget('Archive/Sub/', null)).toEqual({ kind: 'path', raw: 'Archive/Sub/', resolved: 'Archive/Sub' });
		expect(normalizeTarget('', null)).toEqual({ kind: 'empty', raw: '', resolved: null });
	});

	it('matching is case-sensitive', () => {
		expect(normalizeTarget('Archive', null).resolved).not.toBe(normalizeTarget('archive', null).resolved);
	});
});

// ---------------------------------------------------------------------------
// parseSortingSpec / serializeSortingSpec — structure
// ---------------------------------------------------------------------------

describe('parseSortingSpec section splitting', () => {
	it('a target-folder line at indentation 0 starts a section', () => {
		const spec = parseSortingSpec('target-folder: Archive\nItem1\nItem2');
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.targets).toHaveLength(1);
		expect(spec.sections[0]?.rawLines).toEqual(['target-folder: Archive', 'Item1', 'Item2']);
	});

	it('consecutive target lines (blanks/comments notwithstanding) merge into one multi-target section', () => {
		const spec = parseSortingSpec('target-folder: A\n\n// note\ntarget-folder: B\nItem');
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.targets.map((t) => t.raw)).toEqual(['A', 'B']);
	});

	it('a target line after an instruction line starts a new section', () => {
		const spec = parseSortingSpec('target-folder: A\nItem1\ntarget-folder: B\nItem2');
		expect(spec.sections).toHaveLength(2);
	});

	it('blank lines and // comments are inert and never delimit', () => {
		const spec = parseSortingSpec('target-folder: A\n\n// comment\nItem1\n\nItem2');
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.rawLines).toEqual(['target-folder: A', '', '// comment', 'Item1', '', 'Item2']);
	});

	it('an indented target-folder line is a body line, not a header', () => {
		const spec = parseSortingSpec('target-folder: A\n  target-folder: B\nItem');
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.targets).toHaveLength(1);
	});

	it('"::::" is a synonym for target-folder:', () => {
		const spec = parseSortingSpec(':::: Archive\nItem');
		expect(spec.sections[0]?.targets[0]).toMatchObject({ raw: 'Archive', kind: 'path' });
	});

	it('lines before the first target header form the prologue, preserved verbatim', () => {
		const spec = parseSortingSpec('// leading comment\n\ntarget-folder: A\nItem');
		expect(spec.prologue).toEqual(['// leading comment', '']);
	});

	it('the authored marker is detected only immediately after the (last) target line, never before', () => {
		expect(parseSortingSpec('target-folder: .\n// explorer-order-editor\nItem').sections[0]?.authored).toBe(true);
		expect(parseSortingSpec('target-folder: .\n// something else\nItem').sections[0]?.authored).toBe(false);
		const beforeCase = parseSortingSpec('// explorer-order-editor\ntarget-folder: .\nItem');
		expect(beforeCase.prologue).toEqual(['// explorer-order-editor']);
		expect(beforeCase.sections[0]?.authored).toBe(false);
	});

	it('parses/serializes an entirely empty value to an empty spec/string', () => {
		const spec = parseSortingSpec('');
		expect(spec).toEqual({ prologue: [], sections: [], specFolder: null });
		expect(serializeSortingSpec(spec)).toBe('');
	});
});

describe('canonical-value invariant', () => {
	it('normalizes CRLF/CR to LF and drops only trailing blank lines', () => {
		expect(canonicalizeSortingSpec('a\r\nb\rc')).toBe('a\nb\nc');
		expect(canonicalizeSortingSpec('a\n\nb\n\n\n')).toBe('a\n\nb');
		expect(canonicalizeSortingSpec('a\nb\n')).toBe('a\nb');
	});
});

describe('round trip: serialize(parse(x)) === canonicalize(x)', () => {
	const corpus: readonly string[] = [
		'target-folder: /\n// explorer-order-editor\nA\nB',
		'target-folder: .\n\n\ninterior blank preserved\n\n\ntrailing blanks dropped\n\n\n',
		'  target-folder: not a header\ntarget-folder: /\nreal item',
		'target-folder: A\ntarget-folder: B\n// shared\nItem',
		'target-folder: A\r\nItem\r\ntarget-folder: B\r\nItem2\r\n',
		'no target header at all, just stray text\nmore stray text',
	];

	it.each(corpus.map((c, i) => [i, c] as const))('corpus[%i]', (_i, source) => {
		expect(serializeSortingSpec(parseSortingSpec(source, '/'))).toBe(canonicalizeSortingSpec(source));
	});
});

// ---------------------------------------------------------------------------
// specTargets
// ---------------------------------------------------------------------------

describe('specTargets', () => {
	it('true when a single-target section resolves to the key', () => {
		const spec = parseSortingSpec('target-folder: .\nItem', 'Archive');
		expect(specTargets(spec, 'Archive')).toBe(true);
	});

	it('true when the key is one of several targets in a multi-target section', () => {
		const spec = parseSortingSpec('target-folder: Archive\ntarget-folder: Inbox\n// shared\nItem', '/');
		expect(specTargets(spec, 'Inbox')).toBe(true);
	});

	it('false when nothing in the spec targets the key', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\nItem', '/');
		expect(specTargets(spec, 'Archive')).toBe(false);
	});

	it('false for an empty spec', () => {
		expect(specTargets(parseSortingSpec('', '/'), '/')).toBe(false);
	});

	it('does not care whether the matching section is authored by us or foreign', () => {
		const spec = parseSortingSpec('target-folder: .\nHand-written, no marker', 'Notes');
		expect(specTargets(spec, 'Notes')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// hasAuthoredSection — gates the M10c sortspec.md import so it only ever
// touches a folder this plugin already has a section for, never hand-written
// config and never a folder with no section at all.
// ---------------------------------------------------------------------------

describe('hasAuthoredSection', () => {
	it('true when the matching section carries our marker', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nA', 'Notes');
		expect(hasAuthoredSection(spec, '.')).toBe(true);
	});

	it('false when the matching section is hand-written (no marker)', () => {
		const spec = parseSortingSpec('target-folder: .\nHand-written, no marker', 'Notes');
		expect(hasAuthoredSection(spec, '.')).toBe(false);
	});

	it('false when nothing in the spec targets the key at all', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\n// explorer-order-editor\nA', '/');
		expect(hasAuthoredSection(spec, '.')).toBe(false);
	});

	it('false for an empty spec', () => {
		expect(hasAuthoredSection(parseSortingSpec('', '/'), '.')).toBe(false);
	});

	it('true if any one of several matching sections for the same key is authored', () => {
		const spec = parseSortingSpec(
			['target-folder: .', 'Hand-written', '', 'target-folder: .', '// explorer-order-editor', 'Ours'].join('\n'),
			'Notes',
		);
		expect(hasAuthoredSection(spec, '.')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// removeFolderOrder
// ---------------------------------------------------------------------------

describe('removeFolderOrder', () => {
	it('no matching section -> unchanged, same spec by identity', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\nX', '/');
		const result = removeFolderOrder(spec, '.');
		expect(result.status).toBe('unchanged');
		expect(result.spec).toBe(spec);
	});

	it('a foreign matching section is left untouched (only our own content is ever deleted)', () => {
		const spec = parseSortingSpec('target-folder: .\nForeign', '/');
		const result = removeFolderOrder(spec, '.');
		expect(result.status).toBe('unchanged');
		expect(serializeSortingSpec(result.spec)).toBe(serializeSortingSpec(spec));
	});

	it('removes an authored matching section, preserving neighbors byte-for-byte', () => {
		const spec = parseSortingSpec('target-folder: Before\nX\n\ntarget-folder: .\n// explorer-order-editor\nY\n\ntarget-folder: After\nZ', '/');
		const result = removeFolderOrder(spec, '.');
		expect(result.status).toBe('removed');
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: Before\nX\n\ntarget-folder: After\nZ');
	});

	it('removes every authored duplicate for the same target', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nA\n\ntarget-folder: .\n// explorer-order-editor\nB', '/');
		const result = removeFolderOrder(spec, '.');
		expect(result.status).toBe('removed');
		expect(result.spec.sections).toHaveLength(0);
	});

	it('blocks when the target falls inside a multi-target section', () => {
		const spec = parseSortingSpec('target-folder: A\ntarget-folder: B\n// shared\nItem', '/');
		const result = removeFolderOrder(spec, 'A');
		expect(result.status).toBe('blocked');
		expect(result.diagnostics).toEqual([{ kind: 'multi-target-conflict', targets: ['A', 'B'] }]);
	});
});
