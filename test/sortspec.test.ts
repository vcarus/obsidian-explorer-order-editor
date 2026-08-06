import { describe, expect, it } from 'vitest';
import {
	buildNameIndex,
	canonicalizeSortingSpec,
	encodeEntry,
	hasAuthoredSection,
	normalizeTarget,
	parseSortingSpec,
	removeFolderOrder,
	serializeSortingSpec,
	specTargets,
	upsertFolderOrder,
	type EncodeEntryResult,
	type NameIndex,
} from '../src/sortspec';
import type { Entry } from '../src/types';

const file = (name: string): Entry => ({ name, kind: 'file' });
const folder = (name: string): Entry => ({ name, kind: 'folder' });
const emptyIndex: NameIndex = buildNameIndex([]);

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
// encodeEntry / buildNameIndex
// ---------------------------------------------------------------------------

describe('buildNameIndex + encodeEntry: folder/file name collision', () => {
	it('a folder and a file sharing a name both get a disambiguating prefix', () => {
		const idx = buildNameIndex([file('Notes'), folder('Notes')]);
		expect(encodeEntry(file('Notes'), idx)).toEqual({ ok: true, line: '/:files Notes' });
		expect(encodeEntry(folder('Notes'), idx)).toEqual({ ok: true, line: '/folders Notes' });
	});

	it('no collision -> bare name', () => {
		const idx = buildNameIndex([file('Notes'), folder('Other')]);
		expect(encodeEntry(file('Notes'), idx)).toEqual({ ok: true, line: 'Notes' });
	});
});

// One table covering every reserved token, every unrepresentable reason, plus
// a few representative attribute-lexeme / catch-all rows.
const RESERVED_TOKENS = [
	'/',
	'/folders',
	'/:',
	'/:files',
	'/:.',
	'/:files.',
	'%',
	'/%',
	'/%.',
	'/folders:files',
	'/folders:files.',
	'--%',
	'/--hide:',
	'/!',
	'/!!',
	'/!!!',
	'/+',
] as const;

interface EncodeCase {
	readonly label: string;
	readonly name: string;
	readonly expected: EncodeEntryResult;
}

const reservedTokenCases: EncodeCase[] = RESERVED_TOKENS.map((token) => ({
	label: `reserved token ${JSON.stringify(token)}`,
	name: token,
	expected: { ok: true, line: `/:files ${token}` },
}));

const otherCases: EncodeCase[] = [
	{ label: 'reserved token as first space-delimited token', name: '/folders rest of name', expected: { ok: true, line: '/:files /folders rest of name' } },
	{ label: 'attribute lexeme target-folder:', name: 'target-folder: x', expected: { ok: true, line: '/:files target-folder: x' } },
	{ label: 'attribute lexeme ::::', name: '::::x', expected: { ok: true, line: '/:files ::::x' } },
	{ label: 'attribute lexeme <', name: '<x', expected: { ok: true, line: '/:files <x' } },
	{ label: 'attribute lexeme with-metadata:', name: 'with-metadata: x', expected: { ok: true, line: '/:files with-metadata: x' } },
	{ label: 'catch-all %Report', name: '%Report', expected: { ok: true, line: '/:files %Report' } },
	{ label: 'catch-all //comment shape', name: '//comment', expected: { ok: true, line: '/:files //comment' } },
	{ label: 'catch-all --double-dash', name: '--x', expected: { ok: true, line: '/:files --x' } },
	{ label: 'ordinary name, no prefix needed', name: 'Meeting notes', expected: { ok: true, line: 'Meeting notes' } },
	{ label: 'unrepresentable: empty', name: '', expected: { ok: false, reason: 'empty' } },
	{ label: 'unrepresentable: whitespace (leading)', name: ' Foo', expected: { ok: false, reason: 'whitespace' } },
	{ label: 'unrepresentable: whitespace (only)', name: '   ', expected: { ok: false, reason: 'whitespace' } },
	{ label: 'unrepresentable: newline', name: 'Foo\nBar', expected: { ok: false, reason: 'newline' } },
	{ label: 'unrepresentable: carriage return', name: 'Foo\rBar', expected: { ok: false, reason: 'newline' } },
	{ label: 'unrepresentable: wildcard', name: 'a...b', expected: { ok: false, reason: 'wildcard' } },
	{ label: 'unrepresentable: backslash', name: 'a\\b', expected: { ok: false, reason: 'backslash' } },
	{ label: 'evaluation order: "\\<x" is backslash, not the "<" lexeme', name: '\\<x', expected: { ok: false, reason: 'backslash' } },
	{ label: 'evaluation order: wildcard beats backslash when both present', name: 'a...\\b', expected: { ok: false, reason: 'wildcard' } },
];

describe.each([...reservedTokenCases, ...otherCases])('encodeEntry: $label', ({ name, expected }) => {
	it('matches the expected result', () => {
		expect(encodeEntry(file(name), emptyIndex)).toEqual(expected);
	});
});

describe('encodeEntry output re-parses as an instruction and survives trim()', () => {
	const representative = [
		'/',
		'/:files',
		'target-folder: x',
		'::::x',
		'<x',
		'%Report',
		'//comment',
		'Meeting notes',
	];

	it.each(representative)('%s', (name) => {
		const result = encodeEntry(file(name), emptyIndex);
		if (!result.ok) throw new Error(`expected ${name} to be representable`);
		expect(result.line.trim()).toBe(result.line);
		const spec = parseSortingSpec(`target-folder: .\n// explorer-order-editor\n${result.line}`);
		expect(spec.sections).toHaveLength(1);
		expect(spec.sections[0]?.targets).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// upsertFolderOrder — conflict policy
// ---------------------------------------------------------------------------

describe('upsertFolderOrder: no match', () => {
	it('appends a new authored section with no blank-line separator, sharing prior sections by reference', () => {
		const spec = parseSortingSpec('target-folder: Elsewhere\nOld', '/');
		const result = upsertFolderOrder(spec, '.', [file('A'), file('B')]);
		expect(result.status).toBe('appended');
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: Elsewhere\nOld\ntarget-folder: .\n// explorer-order-editor\nA\nB');
		expect(result.spec.sections[0]).toBe(spec.sections[0]);
	});

	it('appends with an empty body when there are no entries', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', []);
		expect(result.status).toBe('appended');
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor');
	});
});

describe('upsertFolderOrder: single foreign match', () => {
	it('replaces it in place (position preserved), warns, and leaves siblings untouched by reference', () => {
		const spec = parseSortingSpec('target-folder: Before\nX\n\ntarget-folder: .\nForeign entry\n\ntarget-folder: After\nY', '/');
		const result = upsertFolderOrder(spec, '.', [file('New')]);
		expect(result.status).toBe('replaced');
		expect(result.diagnostics).toContainEqual({ kind: 'foreign-section-replaced' });
		expect(result.spec.sections[0]).toBe(spec.sections[0]);
		expect(result.spec.sections[2]).toBe(spec.sections[2]);
		expect(result.spec.sections[1]?.rawLines).toEqual(['target-folder: .', '// explorer-order-editor', 'New']);
	});
});

describe('upsertFolderOrder: single authored match', () => {
	it('different content -> replaced, no foreign-section-replaced warning', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nOld', '/');
		const result = upsertFolderOrder(spec, '.', [file('New')]);
		expect(result.status).toBe('replaced');
		expect(result.diagnostics).toEqual([]);
	});

	it('identical content -> unchanged, same spec by identity (idempotency)', () => {
		const spec = parseSortingSpec('target-folder: .\n// explorer-order-editor\nA\nB', '/');
		const result = upsertFolderOrder(spec, '.', [file('A'), file('B')]);
		expect(result.status).toBe('unchanged');
		expect(result.spec).toBe(spec);
	});

	it('running the identical upsert twice produces byte-identical output', () => {
		const spec = parseSortingSpec('target-folder: Foo\nBar', '/');
		const once = upsertFolderOrder(spec, '.', [file('A'), folder('B')]);
		const twice = upsertFolderOrder(once.spec, '.', [file('A'), folder('B')]);
		expect(twice.status).toBe('unchanged');
		expect(serializeSortingSpec(twice.spec)).toBe(serializeSortingSpec(once.spec));
	});
});

describe('upsertFolderOrder: multiple exact matches', () => {
	it('all authored by us -> keeps the last, deletes the earlier ones', () => {
		const spec = parseSortingSpec(
			['target-folder: .', '// explorer-order-editor', 'Old1', '', 'target-folder: .', '// explorer-order-editor', 'Old2'].join('\n'),
			'/',
		);
		const result = upsertFolderOrder(spec, '.', [file('New')]);
		expect(result.status).toBe('replaced');
		expect(result.spec.sections).toHaveLength(1);
		expect(result.spec.sections[0]?.rawLines).toEqual(['target-folder: .', '// explorer-order-editor', 'New']);
	});

	it('any foreign among duplicates -> blocked + duplicate-section with a count, spec unchanged by identity', () => {
		const spec = parseSortingSpec('target-folder: Archive\nForeign1\n\ntarget-folder: Archive\nForeign2', '/');
		const result = upsertFolderOrder(spec, 'Archive', [file('New')]);
		expect(result.status).toBe('blocked');
		expect(result.diagnostics).toEqual([{ kind: 'duplicate-section', count: 2 }]);
		expect(result.spec).toBe(spec);
	});
});

describe('upsertFolderOrder: multi-target conflict', () => {
	it('blocks the save and returns the input spec unchanged by identity', () => {
		const spec = parseSortingSpec('target-folder: Archive\ntarget-folder: Inbox\n// shared\nItem', '/');
		const result = upsertFolderOrder(spec, 'Archive', [file('New')]);
		expect(result.status).toBe('blocked');
		expect(result.spec).toBe(spec);
		expect(result.diagnostics).toEqual([{ kind: 'multi-target-conflict', targets: ['Archive', 'Inbox'] }]);
	});
});

describe('upsertFolderOrder: unrepresentable entries', () => {
	it('are skipped with a diagnostic, without blocking the rest of the save', () => {
		const entries = [file('Good1'), file('a...b'), file('Good2')];
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(result.status).toBe('appended');
		expect(result.diagnostics).toEqual([{ kind: 'unrepresentable-entry', name: 'a...b', reason: 'wildcard' }]);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\nGood1\nGood2');
	});

	it('several different unencodable reasons in one save are all skipped, and the rest still saves', () => {
		const entries = [file('Good1'), file(' leading space'), file('a...b'), file('back\\slash'), file('Good2'), file('')];
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', entries);
		expect(result.status).toBe('appended');
		expect(result.diagnostics).toEqual([
			{ kind: 'unrepresentable-entry', name: ' leading space', reason: 'whitespace' },
			{ kind: 'unrepresentable-entry', name: 'a...b', reason: 'wildcard' },
			{ kind: 'unrepresentable-entry', name: 'back\\slash', reason: 'backslash' },
			{ kind: 'unrepresentable-entry', name: '', reason: 'empty' },
		]);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\nGood1\nGood2');
	});
});

// ---------------------------------------------------------------------------
// upsertFolderOrder: hideNames (custom-sort's own `/--hide:` item-hide
// directive, emitted for the "hide sortspec.md" setting)
// ---------------------------------------------------------------------------

describe('upsertFolderOrder: hideNames', () => {
	it('emits one "/--hide: <name>" line per hidden name, right after the marker and before entries', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('A'), folder('B')], ['sortspec.md']);
		expect(result.status).toBe('appended');
		expect(serializeSortingSpec(result.spec)).toBe(
			'target-folder: .\n// explorer-order-editor\n/--hide: sortspec.md\nA\nB',
		);
	});

	it('supports multiple hidden names, in the given order', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', [], ['a.md', 'b.md']);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\n/--hide: a.md\n/--hide: b.md');
	});

	it('defaults to no hidden names when the parameter is omitted', () => {
		const result = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('A')]);
		expect(serializeSortingSpec(result.spec)).toBe('target-folder: .\n// explorer-order-editor\nA');
	});

	it('running the identical upsert with the same hideNames twice is idempotent', () => {
		const once = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('A')], ['sortspec.md']);
		const twice = upsertFolderOrder(once.spec, '.', [file('A')], ['sortspec.md']);
		expect(twice.status).toBe('unchanged');
		expect(serializeSortingSpec(twice.spec)).toBe(serializeSortingSpec(once.spec));
	});

	it('turning hideNames on for an already-saved folder is a real change, not a no-op', () => {
		const withoutHide = upsertFolderOrder(parseSortingSpec('', '/'), '.', [file('A')]);
		const withHide = upsertFolderOrder(withoutHide.spec, '.', [file('A')], ['sortspec.md']);
		expect(withHide.status).toBe('replaced');
		expect(serializeSortingSpec(withHide.spec)).toContain('/--hide: sortspec.md');
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
// hasAuthoredSection — gates the vault-wide "hide sortspec.md" sync
// (syncHideSetting) so it only ever touches a folder this plugin already
// has a section for, never hand-written config and never a folder with no
// section at all.
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

// ---------------------------------------------------------------------------
// Inverse property: serialize(remove(upsert(S, T, E))) === serialize(S), when
// S has no section matching T.
// ---------------------------------------------------------------------------

describe('inverse property: remove(upsert(S,T,E)) === S byte-for-byte', () => {
	const fixtures: readonly [string, string][] = [
		['empty spec', ''],
		['unrelated foreign section', 'target-folder: Archive\n// note\nOld'],
		['multiple unrelated sections', 'target-folder: A\nX\n\ntarget-folder: B\nY'],
		['prologue plus a section', '// header comment\n\ntarget-folder: Archive\nOld'],
	];

	it.each(fixtures)('%s', (_label, source) => {
		const S = parseSortingSpec(source, '/');
		const upserted = upsertFolderOrder(S, '.', [file('A'), folder('B')]);
		const removed = removeFolderOrder(upserted.spec, '.');
		expect(serializeSortingSpec(removed.spec)).toBe(serializeSortingSpec(S));
	});
});

// ---------------------------------------------------------------------------
// Fidelity: after an upsert, every non-matching section is reference-identical
// (and therefore byte-identical) to the input.
// ---------------------------------------------------------------------------

describe('fidelity: non-matching sections are untouched by reference', () => {
	it('survive an append', () => {
		const spec = parseSortingSpec('target-folder: A\nX\n\ntarget-folder: B\nY', '/');
		const result = upsertFolderOrder(spec, '.', [file('New')]);
		expect(result.spec.sections[0]).toBe(spec.sections[0]);
		expect(result.spec.sections[1]).toBe(spec.sections[1]);
	});

	it('survive a blocked mutation (whole spec returned by identity)', () => {
		const spec = parseSortingSpec('target-folder: A\ntarget-folder: B\n// shared\nItem\n\ntarget-folder: C\nZ', '/');
		const result = upsertFolderOrder(spec, 'A', [file('New')]);
		expect(result.spec).toBe(spec);
	});
});
