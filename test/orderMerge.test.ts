import { describe, expect, it } from 'vitest';
import { mergeStoredOrder, parseSortingSpec, readFolderOrder, renameEntryInOrder, upsertFolderOrder } from '../src/sortspec';
import { entryNameForFileName, type Entry } from '../src/types';

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

describe('renameEntryInOrder', () => {
	it('renames the middle item in place; every other item is untouched, by reference', () => {
		const a = file('A');
		const b = file('B');
		const c = file('C');
		const to = file('B-renamed');
		const renamed = renameEntryInOrder([a, b, c], b, to);
		expect(renamed).toEqual([a, to, c]);
		// Not just equal — the same object references, proving the entries
		// that weren't renamed were never touched at all.
		expect(renamed?.[0]).toBe(a);
		expect(renamed?.[1]).toBe(to);
		expect(renamed?.[2]).toBe(c);
	});

	it('`from` not present in the order -> null, the caller\'s signal to write nothing', () => {
		const order = [file('A'), file('B')];
		expect(renameEntryInOrder(order, file('Missing'), file('New'))).toBeNull();
	});

	it('a folder and a file sharing a name are distinct identities: renaming one leaves the other exactly where it was', () => {
		const theFile = file('Foo');
		const order = [folder('Foo'), theFile];
		const renamed = renameEntryInOrder(order, folder('Foo'), folder('Bar'));
		expect(renamed).toEqual([folder('Bar'), theFile]);
		expect(renamed?.[1]).toBe(theFile);
	});

	it('`to` already exists elsewhere in the order: that occurrence is deleted, the renamed slot keeps the position', () => {
		const b = file('B');
		const order = [file('A'), b, file('C')];
		// Renaming "A" to "C", where "C" is already listed later.
		const renamed = renameEntryInOrder(order, file('A'), file('C'));
		expect(renamed).toEqual([file('C'), b]);
	});

	it('idempotent: applying the same rename a second time finds nothing left to rename and returns null', () => {
		const order = [file('A'), file('B')];
		const once = renameEntryInOrder(order, file('A'), file('A2'));
		expect(once).not.toBeNull();
		const twice = renameEntryInOrder(once as readonly Entry[], file('A'), file('A2'));
		expect(twice).toBeNull();
	});

	it('does not mutate the input array or any of its entries', () => {
		const a = file('A');
		const b = file('B');
		const order = [a, b];
		const orderSnapshot = [...order];
		const result = renameEntryInOrder(order, a, file('A2'));
		expect(order).toEqual(orderSnapshot);
		expect(order[0]).toBe(a);
		expect(order[1]).toBe(b);
		// The returned array is a distinct instance, not the mutated input.
		expect(result).not.toBe(order);
	});

	it('combined with mergeStoredOrder, a renamed entry keeps its stored position — the defect this function fixes', () => {
		const stored = [file('Todo'), folder('Archive'), file('Welcome')];
		// "Todo" was renamed to "Notes"; the live siblings now reflect that.
		const renamedSiblings = [folder('Archive'), file('Notes'), file('Welcome')];

		const renamed = renameEntryInOrder(stored, file('Todo'), file('Notes'));
		expect(renamed).not.toBeNull();
		expect(mergeStoredOrder(renamed, renamedSiblings)).toEqual([file('Notes'), folder('Archive'), file('Welcome')]);

		// Control: merging the *un-rewritten* stored order against the same
		// post-rename siblings reproduces the pre-M6 bug — "Notes" isn't
		// recognized as anything already in `stored`, so it falls off the end.
		expect(mergeStoredOrder(stored, renamedSiblings)).toEqual([folder('Archive'), file('Welcome'), file('Notes')]);
	});

	it('a bare (unprefixed) line for a folder round-trips through the pre-rename sibling reconstruction orderSync uses', () => {
		// No file shares this name, so encodeEntry writes "Projects" as a bare
		// line with no /folders prefix — the exact case readFolderOrder can
		// only classify correctly by consulting siblings.
		const siblings = [folder('Projects'), file('Welcome')];
		const upserted = upsertFolderOrder(parseSortingSpec('', '/'), '.', siblings);
		expect(upserted.status).toBe('appended');

		// Mirrors orderSync's rename-path reconstruction (see orderSync.ts):
		// after the rename, live siblings no longer contain the old name, so
		// it's added back in (as `from`, with its real kind) while the
		// sibling now bearing the *new* name is excluded to avoid listing it
		// twice.
		const from = folder('Projects');
		const to = folder('ProjectsRenamed');
		const postRenameSiblings = [folder('ProjectsRenamed'), file('Welcome')];
		const readSiblings = [...postRenameSiblings.filter((s) => !(s.name === to.name && s.kind === to.kind)), from];

		const stored = readFolderOrder(upserted.spec, '.', readSiblings);
		expect(stored).not.toBeNull();
		const projectsEntry = stored?.find((e) => e.name === 'Projects');
		// The whole point: without the pre-rename sibling view, a bare line
		// defaults to 'file' and this would be 'file', not 'folder'.
		expect(projectsEntry?.kind).toBe('folder');

		const renamed = renameEntryInOrder(stored as readonly Entry[], from, to);
		expect(renamed).not.toBeNull();
		expect(renamed?.some((e) => e.name === 'ProjectsRenamed' && e.kind === 'folder')).toBe(true);
	});
});

describe('renaming an entry that had no line at all', () => {
	// Regression: an unrepresentable name is never written to the spec, so
	// renaming *away* from one finds nothing to rename. orderSync used to treat
	// that null as "nothing to do", which left the now-representable name
	// unlisted — and custom-sort puts every unlisted child after every listed
	// one, so in the file explorer it stayed down among the other
	// unrepresentable names instead of joining the ordered list. The fix is to
	// fall through to a plain reconcile; these assertions pin both halves.
	it('a name that has just become representable is appended into the order', () => {
		// "% catch all" starts with a reserved token, so encodeEntry refuses it.
		const before = [file('% catch all'), file('normal note'), file('welcome')];
		const upserted = upsertFolderOrder(parseSortingSpec('', '/'), '.', before);
		expect(upserted.status).toBe('appended');
		expect(upserted.diagnostics).toEqual([{ kind: 'unrepresentable-entry', name: '% catch all', reason: 'reserved-token' }]);

		const stored = readFolderOrder(upserted.spec, '.', before);
		// The premise: it really has no line, so there is nothing to rename.
		expect(stored).toEqual([file('normal note'), file('welcome')]);
		expect(renameEntryInOrder(stored as readonly Entry[], file('% catch all'), file('111'))).toBeNull();

		// Reconciling against the post-rename children is what gives it a line.
		const after = [file('111'), file('normal note'), file('welcome')];
		const reconciled = upsertFolderOrder(upserted.spec, '.', mergeStoredOrder(stored, after));
		expect(reconciled.status).toBe('replaced');
		expect(readFolderOrder(reconciled.spec, '.', after)).toEqual([file('normal note'), file('welcome'), file('111')]);
	});

	it('still writes nothing when the new name is also unrepresentable', () => {
		const before = [file('% catch all'), file('normal note'), file('welcome')];
		const upserted = upsertFolderOrder(parseSortingSpec('', '/'), '.', before);

		const stored = readFolderOrder(upserted.spec, '.', before);
		// One unrepresentable name traded for another: the reconcile runs, finds
		// nothing it can encode differently, and upsertFolderOrder reports
		// 'unchanged' — so orderSync performs no write and schedules no refresh.
		const after = [file('--% hidden'), file('normal note'), file('welcome')];
		const reconciled = upsertFolderOrder(upserted.spec, '.', mergeStoredOrder(stored, after));
		expect(reconciled.status).toBe('unchanged');
	});
});

describe('entryNameForFileName', () => {
	it('strips a .md extension', () => {
		expect(entryNameForFileName('note.md')).toBe('note');
	});

	it('keeps a non-.md extension as part of the name', () => {
		expect(entryNameForFileName('a.txt')).toBe('a.txt');
	});

	it('a name with no extension at all is returned unchanged', () => {
		expect(entryNameForFileName('noext')).toBe('noext');
	});

	it('an extension-only name strips down to the empty string', () => {
		expect(entryNameForFileName('.md')).toBe('');
	});

	it('only the final .md is stripped, not an earlier one', () => {
		expect(entryNameForFileName('a.md.md')).toBe('a.md');
	});

	it('the .md match is case-sensitive, mirroring TFile.extension', () => {
		expect(entryNameForFileName('A.MD')).toBe('A.MD');
	});
});
