/**
 * Shared vocabulary between the pure sortspec layer and the UI.
 *
 * `name` is the exact string custom-sort matches against, already resolved:
 * `.md` files use their basename (no extension), every other file uses its
 * full name including the extension, and folders use the folder name.
 * Resolving that is `sortspecFile.ts`'s job — nothing downstream re-derives it.
 */
export type EntryKind = 'file' | 'folder';

export interface Entry {
	readonly name: string;
	readonly kind: EntryKind;
}
