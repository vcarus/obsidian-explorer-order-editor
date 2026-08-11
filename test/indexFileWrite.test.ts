/**
 * `performWrite`'s refusal to overwrite a note whose json block has gone
 * missing, through the stub in `test/stubs/obsidian.ts`.
 *
 * Read that stub's header first. These assert *our* control flow — which
 * evidence the write path is willing to treat as proof a block existed — and
 * nothing about how Obsidian behaves. Hand testing in `testvault/` is still
 * what decides whether a change works.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexFileStore } from '../src/indexFile';
import { serializeIndex, setOrder } from '../src/orderIndex';
import { NOTE, makeHost } from './helpers';
import { resetNotices } from './stubs/obsidian';

beforeEach(() => {
	resetNotices();
});

describe('a note whose json block is missing', () => {
	it('gets one appended on the first write when nothing says it ever had one', async () => {
		// The regression this exists for: a note that already exists at
		// `indexPath` with prose and no fenced block — hand-made, or its block
		// removed while the plugin was off with no backup to remember it.
		// Reading the in-memory index as proof a block was written refused this
		// write outright, left the order unwritten, and marked the store
		// unusable, all without throwing.
		const { host, stub } = makeHost();
		stub.app.vault.files.set(NOTE, 'Some notes of my own.\n');

		const store = new IndexFileStore(host);
		await store.load();
		expect(store.isUsable()).toBe(true);

		expect(store.update((i) => setOrder(i, 'navtest', ['a.md']))).toBe(true);
		await store.flush();

		expect(store.isUsable()).toBe(true);
		const written = stub.app.vault.files.get(NOTE) ?? '';
		expect(written).toContain('navtest');
		// The prose around the block is not collateral.
		expect(written).toContain('Some notes of my own.');
	});

	it('is still refused when the note is known to have held one', async () => {
		// The case the guard exists for, and the one that must survive the fix:
		// a block that was really there and then vanished under us is damage,
		// not a blank slate to append to.
		const { host, stub } = makeHost();
		stub.app.vault.files.set(NOTE, serializeIndex('', new Map([['navtest', ['a.md']]])));

		const store = new IndexFileStore(host);
		await store.load();
		expect(store.isUsable()).toBe(true);

		// The block disappears after a good read, with nothing having told the
		// store yet — the debounced write is what arrives first.
		stub.app.vault.files.set(NOTE, 'Someone removed the block.\n');

		expect(store.update((i) => setOrder(i, 'navtest', ['a.md', 'b.md']))).toBe(true);
		await store.flush();

		expect(store.isUsable()).toBe(false);
		expect(store.unusableReason()).toBe('Its json block is missing');
		// Refused means refused: the note is exactly as it was found.
		expect(stub.app.vault.files.get(NOTE)).toBe('Someone removed the block.\n');
	});

	it('is refused by the write path on the strength of the backup alone', async () => {
		// The load-path twin below never reaches `performWrite` — `load()`
		// refuses first — so until this test existed, `blockWasStored`'s backup
		// term could be deleted with every test still green. Here the store has
		// to be usable first (no note at all at load time, so `sawBlock` is
		// false and `lastWrittenText` is null), and the block-less note lands
		// *between* the user's edit and the debounced write: the backup is then
		// the only witness the write path has.
		const { host, stub } = makeHost();
		await stub.saveData({ indexBackup: serializeIndex('', new Map([['navtest', ['a.md']]])) });

		const store = new IndexFileStore(host);
		await store.load();
		expect(store.isUsable()).toBe(true);

		expect(store.update((i) => setOrder(i, 'navtest', ['a.md', 'b.md']))).toBe(true);
		// A sync client lands a block-less copy of the note before the write
		// fires — the vault now has a file where load() saw none.
		stub.app.vault.files.set(NOTE, 'Block-less after a sync landed.\n');
		await store.flush();

		expect(store.isUsable()).toBe(false);
		expect(store.unusableReason()).toBe('Its json block is missing');
		expect(stub.app.vault.files.get(NOTE)).toBe('Block-less after a sync landed.\n');
	});

	it('is refused at load on the strength of the backup alone, across a restart', async () => {
		// No `sawBlock`, no `lastWrittenText` — a fresh store that never read a
		// good block this session. `data.json` is the only witness left, and it
		// has to be enough.
		const { host, stub } = makeHost();
		await stub.saveData({ indexBackup: serializeIndex('', new Map([['navtest', ['a.md']]])) });
		stub.app.vault.files.set(NOTE, 'Block-less after a sync landed.\n');

		const store = new IndexFileStore(host);
		await store.load();

		// `load` already refuses this one, which is the older half of the same
		// judgment — recorded here so the two halves stay described together.
		expect(store.isUsable()).toBe(false);
		expect(stub.app.vault.files.get(NOTE)).toBe('Block-less after a sync landed.\n');
	});
});
