/**
 * The one seam between the stub and the real store types, shared by every
 * test file that builds a live `IndexFileStore` (`indexFileRepair`,
 * `indexFileWrite`, `notices`) — it existed as three identical copies until
 * 2026-08-11, each carrying its own copy of the cast the comment below
 * justifies.
 *
 * The stub is imported by path, never by mapping `obsidian` to it in
 * `test/tsconfig.json`. A mapping would apply to `src/**` as well — this
 * project compiles those too — and every module here would then be checked
 * against the stub's tiny surface instead of the real API, which is the one
 * check that actually protects the plugin. Types come from the real package
 * everywhere; only the runtime module is substituted, by the alias in
 * `vitest.config.ts`.
 *
 * The cast is where those two facts meet, and it is the only place they do.
 * It is honest at run time precisely because of that alias.
 *
 * Settings are spread from `DEFAULT_SETTINGS` rather than naming the one
 * field the store reads, so a key added later cannot leave this compiling
 * against a shape the plugin no longer has.
 */
import { type IndexFileHost, IndexFileStore } from '../src/indexFile';
import { DEFAULT_SETTINGS } from '../src/settings';
import { StubPlugin } from './stubs/obsidian';

/** The index note path every store-backed test uses. */
export const NOTE = 'explorer-order.md';

/**
 * The members of `IndexFileHost` that are *ours* rather than `Plugin`'s.
 *
 * The cast below erases structural checking wholesale, which is fine for the
 * Obsidian half (that is the point of a stub) and not fine for this half: when
 * `readData` was added to the contract, nothing anywhere would have failed had
 * the stub not grown it too — lint, both tsc projects and vitest all stay
 * green until some test happens to reach it, and then it fails as
 * `this.host.readData is not a function`, blamed on whichever test ran first.
 * Annotating the construction puts that one gate back.
 */
type HostSurface = Pick<IndexFileHost, 'readData' | 'updateData' | 'saveSettings'>;

export function makeHost(): { host: IndexFileHost; stub: StubPlugin } {
	const stub: StubPlugin & HostSurface = new StubPlugin();
	const host = stub as unknown as IndexFileHost;
	host.settings = { ...DEFAULT_SETTINGS, indexPath: NOTE };
	return { host, stub };
}

/**
 * A store that has already been through `load()` against `noteText` at `NOTE`,
 * with `backup` seeded into `data.json` first when given.
 *
 * The load sequence, not just the host: every store-backed test needs the note
 * on disk *before* `load()` runs, since that is the only path that decides
 * usable vs unusable, and seeding the backup afterwards would be a different
 * scenario than the one being described. Shared for the same reason `makeHost`
 * is — it existed as two identical copies plus four open-coded repeats, and
 * the whole risk in a helper like this is one copy drifting into a sequence
 * the others don't run.
 */
export async function loadedStore(noteText: string, backup?: string): Promise<{ store: IndexFileStore; stub: StubPlugin }> {
	const { host, stub } = makeHost();
	stub.app.vault.files.set(NOTE, noteText);
	if (backup !== undefined) await stub.saveData({ indexBackup: backup });
	const store = new IndexFileStore(host);
	await store.load();
	return { store, stub };
}
