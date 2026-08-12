/**
 * The write path, through the stub in `test/stubs/obsidian.ts`: what
 * `performWrite` refuses to overwrite, and what survives the two moments a
 * pending write can be taken away from it — the plugin being torn down, and
 * an external write landing inside the debounce window.
 *
 * Read that stub's header first. These assert *our* control flow — which
 * evidence the write path treats as proof a block existed, which of two
 * indexes it keeps — and nothing about how Obsidian behaves. Hand testing in
 * `testvault/` is still what decides whether a change works.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexFileStore } from '../src/indexFile';
import { parseIndex, serializeIndex, setOrder } from '../src/orderIndex';
import { NOTE, loadedStore, makeHost } from './helpers';
import { notices, resetNotices, type StubPlugin } from './stubs/obsidian';

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

/**
 * The debounce window around teardown. `Component.unload` drains the
 * callbacks handed to `register()` before it calls `onunload`, so the store's
 * own teardown always runs first and `main.ts`'s `flush()` arrives second —
 * that ordering is Obsidian's, established from `obsidian.asar` in
 * `obsidian-internals.md`, and nothing here asserts it. What these assert is
 * ours: that a write still armed at that moment reaches the note.
 */
describe('a write still armed when the plugin is torn down', () => {
	it('lands, rather than being cancelled with the timer', async () => {
		const { store, stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md']]])));

		expect(store.update((i) => setOrder(i, 'navtest', ['b.md', 'a.md']))).toBe(true);
		// Still only armed: the debounce has not fired, so the note is untouched.
		expect(stub.app.vault.files.get(NOTE) ?? '').not.toContain('b.md');

		// Teardown first, then `onunload` — the order Obsidian uses.
		stub.runTeardowns();
		await store.flush();

		expect(stub.app.vault.files.get(NOTE) ?? '').toContain('b.md');
	});

	it('is not written twice when flush follows the teardown', async () => {
		// `commitPendingWrite` is called by both, and the second call must find
		// nothing armed. Idempotence of the *content* is `orderIndex`'s job;
		// what matters here is that the note ends in the state the one write
		// intended.
		const { store, stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md']]])));

		expect(store.update((i) => setOrder(i, 'navtest', ['b.md', 'a.md']))).toBe(true);
		stub.runTeardowns();
		await store.flush();
		const afterFirst = stub.app.vault.files.get(NOTE) ?? '';
		await store.flush();

		expect(stub.app.vault.files.get(NOTE) ?? '').toBe(afterFirst);
	});

	it('leaves the note alone when nothing was armed', async () => {
		const original = serializeIndex('', new Map([['navtest', ['a.md']]]));
		const { store, stub } = await loadedStore(original);

		stub.runTeardowns();
		await store.flush();

		expect(stub.app.vault.files.get(NOTE)).toBe(original);
	});
});

/**
 * An external write landing inside the 200ms debounce window. Fired
 * explicitly through the stub's `fireModify` — writing to `files` notifies
 * nobody, which is what every other test here relies on.
 *
 * Ours to assert: which of the two indexes the store keeps. Not ours: whether
 * Obsidian really delivers `modify` in this window, or how fast.
 */
describe('an external modify arriving while a write is still armed', () => {
	it('keeps the reorder that has not been flushed yet', async () => {
		const { store, stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md', 'b.md']]])));

		// In memory now; on disk when the debounce fires.
		expect(store.update((i) => setOrder(i, 'navtest', ['b.md', 'a.md']))).toBe(true);

		// A sync client lands a perfectly valid *older* copy.
		stub.app.vault.files.set(NOTE, serializeIndex('', new Map([['navtest', ['a.md', 'b.md']]])));
		stub.app.vault.fire('modify', NOTE);
		// `onExternalModify` is fired and not awaited by the store, so let its
		// read settle before the write goes out — otherwise this would be
		// asserting on whichever promise happened to win.
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		await store.flush();

		expect(store.isUsable()).toBe(true);
		expect(store.get('navtest')).toEqual(['b.md', 'a.md']);

		const onDisk = parseIndex(stub.app.vault.files.get(NOTE) ?? '');
		expect(onDisk.status).toBe('ok');
		expect(onDisk.status === 'ok' ? onDisk.index.get('navtest') : null).toEqual(['b.md', 'a.md']);
	});

	it('still adopts an external change when nothing is armed', async () => {
		// The guard must not turn into "never accept external edits": with no
		// pending write there is nothing of ours to lose.
		const { store, stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md', 'b.md']]])));

		stub.app.vault.files.set(NOTE, serializeIndex('', new Map([['navtest', ['b.md', 'a.md']]])));
		stub.app.vault.fire('modify', NOTE);
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		expect(store.isUsable()).toBe(true);
		expect(store.get('navtest')).toEqual(['b.md', 'a.md']);
	});
});

describe('an unreadable data.json', () => {
	/**
	 * Cold start with no note: `sawBlock` is false and `lastWrittenText` is
	 * null, so the backup is the only witness `blockWasStored` has — and an
	 * unreadable `data.json` used to answer it with an empty index, i.e. "this
	 * path never held a block". The user reorders, a block-less copy of a note
	 * that did hold orders lands, and the write appends a fresh block over it:
	 * the outcome `applyParsed`'s own comment calls the worst available.
	 */
	async function reorderAgainstABlockLessNote(stub: StubPlugin, store: IndexFileStore): Promise<void> {
		expect(store.update((i) => setOrder(i, 'navtest', ['a.md', 'b.md']))).toBe(true);
		stub.app.vault.files.set(NOTE, 'Block-less after a sync landed.\n');
		await store.flush();
	}

	it('does not let an unreadable data.json read as proof no block was ever written', async () => {
		// `unreadableData`, not `failLoadData`: Obsidian returns `undefined`
		// here and never throws, so this is the path a user actually reaches —
		// a corrupt or unreadable file, not an exception. The `catch` this
		// verdict used to depend on cannot run in the real app at all.
		const { host, stub } = makeHost();
		const store = new IndexFileStore(host);
		await store.load();
		expect(store.isUsable()).toBe(true);

		stub.unreadableData = true;
		await reorderAgainstABlockLessNote(stub, store);

		expect(store.isUsable()).toBe(false);
		expect(store.unusableReason()).toBe('Its json block is missing');
		expect(stub.app.vault.files.get(NOTE)).toBe('Block-less after a sync landed.\n');
	});

	it('reaches the same verdict when a host breaks the no-throw contract', async () => {
		// `readBackup`'s own `try`/`catch` has exactly one way in: a `readData`
		// that throws, which `IndexFileHost` says cannot happen. So that is
		// what this sets up — not a throwing `loadData`, which the real
		// `readData` would have absorbed into `'unreadable'` anyway.
		const { host, stub } = makeHost();
		const store = new IndexFileStore(host);
		await store.load();

		stub.failReadData = 'data.json is locked';
		await reorderAgainstABlockLessNote(stub, store);

		expect(store.isUsable()).toBe(false);
		expect(store.unusableReason()).toBe('Its json block is missing');
		expect(stub.app.vault.files.get(NOTE)).toBe('Block-less after a sync landed.\n');
	});

	it('treats a backup key that is present but unusable as evidence, not as a fresh start', async () => {
		// The key existing is proof a backup was written here, and a backup is
		// only ever written after a block was — so a corrupt one answers the
		// same "yes, a block existed" an unreadable file does. Reading it as
		// `new Map()` was the fixed bug's own shape, one level in: a
		// half-merged `data.json` plus a block-less note, and the write
		// appends a fresh block over every saved order.
		const { host, stub } = makeHost();
		await stub.saveData({ indexBackup: '```json\n{ not json at all\n```\n' });
		const store = new IndexFileStore(host);
		await store.load();

		await reorderAgainstABlockLessNote(stub, store);

		expect(store.isUsable()).toBe(false);
		expect(store.unusableReason()).toBe('Its json block is missing');
		expect(stub.app.vault.files.get(NOTE)).toBe('Block-less after a sync landed.\n');
	});

	it('still treats an absent data.json as the fresh start it is', async () => {
		// The other side: this must not become "always refuse". With no
		// `data.json` at all — a first install — a block-less note really is a
		// blank slate and the block gets appended.
		const { store, stub } = await loadedStore('Some notes of my own.\n');

		expect(store.update((i) => setOrder(i, 'navtest', ['a.md']))).toBe(true);
		await store.flush();

		expect(store.isUsable()).toBe(true);
		expect(stub.app.vault.files.get(NOTE) ?? '').toContain('navtest');
	});

	it('still treats a readable data.json with no backup key as a fresh start', async () => {
		// The third `DataRead` case, which the two above do not reach: the file
		// is there and parses, it simply holds no backup. That is positive
		// evidence of a fresh start, and must stay distinct from `undefined`.
		const { store, stub } = await loadedStore('Some notes of my own.\n');
		await stub.saveData({ autoRefresh: true });

		expect(store.update((i) => setOrder(i, 'navtest', ['a.md']))).toBe(true);
		await store.flush();

		expect(store.isUsable()).toBe(true);
		expect(stub.app.vault.files.get(NOTE) ?? '').toContain('navtest');
	});
});

describe('a write that throws', () => {
	it('retries a bounded number of times and then says so, instead of losing the change in silence', async () => {
		// `update()` already returned true and the caller already told the user
		// the order was saved. The catch used to end there: nothing re-armed
		// the debounce, `persistBackup` never ran, and the change existed only
		// in `this.index` until the next restart loaded a note without it.
		const { store, stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md']]])));
		stub.app.vault.failProcess = 'EACCES';
		resetNotices();

		vi.useFakeTimers();
		try {
			expect(store.update((i) => setOrder(i, 'navtest', ['b.md', 'a.md']))).toBe(true);

			// The first debounce plus every retry it arms. Generous on purpose:
			// what is asserted is that the retries are *bounded and reported*,
			// not the exact count, which is `MAX_WRITE_RETRIES`' business.
			for (let round = 0; round < 8; round++) await vi.advanceTimersByTimeAsync(250);
		} finally {
			vi.useRealTimers();
		}

		expect(notices.some((notice) => notice.includes('could not write'))).toBe(true);
		// Still applied in memory — the Notice says so, and it has to be true.
		expect(store.get('navtest')).toEqual(['b.md', 'a.md']);
	});

	it('stops retrying once the write succeeds, and says nothing', async () => {
		const { store, stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md']]])));
		stub.app.vault.failProcess = 'EACCES';
		resetNotices();

		vi.useFakeTimers();
		try {
			expect(store.update((i) => setOrder(i, 'navtest', ['b.md', 'a.md']))).toBe(true);
			await vi.advanceTimersByTimeAsync(250);
			stub.app.vault.failProcess = null;
			for (let round = 0; round < 8; round++) await vi.advanceTimersByTimeAsync(250);
		} finally {
			vi.useRealTimers();
		}

		expect(notices).toEqual([]);
		expect(stub.app.vault.files.get(NOTE) ?? '').toContain('b.md');
	});
});

/**
 * The index note is the one file this plugin owns, and `orderSync.ts`
 * deliberately leaves it out of its remit — so these two events had nothing
 * watching them at all.
 */
describe('the index note being renamed or deleted', () => {
	it('follows a rename, so the next write does not recreate a duplicate at the old path', async () => {
		const { store, stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md']]])));
		const moved = 'notes/explorer-order.md';
		stub.app.vault.files.set(moved, stub.app.vault.files.get(NOTE) ?? '');
		stub.app.vault.files.delete(NOTE);
		resetNotices();

		stub.app.vault.fire('rename', moved, NOTE);
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		expect(host_indexPath(stub)).toBe(moved);
		expect(notices.some((notice) => notice.includes(moved))).toBe(true);

		// And the write lands on the new path, leaving nothing at the old one.
		expect(store.update((i) => setOrder(i, 'navtest', ['b.md', 'a.md']))).toBe(true);
		await store.flush();
		expect(stub.app.vault.files.get(moved) ?? '').toContain('b.md');
		expect(stub.app.vault.files.has(NOTE)).toBe(false);
	});

	it('ignores a rename of some other note', async () => {
		const { stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md']]])));
		resetNotices();

		stub.app.vault.fire('rename', 'somewhere/else.md', 'other.md');
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		expect(host_indexPath(stub)).toBe(NOTE);
		expect(notices).toEqual([]);
	});

	it('says what will happen when the note is deleted, and changes nothing', async () => {
		// Neither reading of a delete ("start over" / "a sync client removed
		// it") can be told apart from a vault event, so this reports instead
		// of guessing — the orders stay loaded, and the Notice has to name the
		// settings row that really clears them. Asserted on that exact wording
		// because an earlier draft named a button from a different flow.
		const { store, stub } = await loadedStore(serializeIndex('', new Map([['navtest', ['a.md']]])));
		stub.app.vault.files.delete(NOTE);
		resetNotices();

		stub.app.vault.fire('delete', NOTE);

		expect(notices.some((notice) => notice.includes('Clear every saved order'))).toBe(true);
		expect(store.get('navtest')).toEqual(['a.md']);
		expect(store.isUsable()).toBe(true);
	});
});

/** The store mutates `settings` on its host; this reads it back through the same object `makeHost` handed over. */
function host_indexPath(stub: StubPlugin): string {
	return (stub as unknown as { settings: { indexPath: string } }).settings.indexPath;
}
