import { describe, expect, it } from 'vitest';
import { folderChoices, noteLocationRow, notePathIn, planNoteMove } from '../src/notePlacement';

const identity = (path: string): string => path;
const nothingTaken = (): boolean => false;

describe('notePathIn', () => {
	it('puts the note directly at the root when the folder is the root', () => {
		expect(notePathIn('', 'Maintenance/explorer-order.md')).toBe('explorer-order.md');
	});

	it('keeps the file name and replaces only the folder', () => {
		expect(notePathIn('Maintenance', 'explorer-order.md')).toBe('Maintenance/explorer-order.md');
		expect(notePathIn('A/B', 'Old/order.md')).toBe('A/B/order.md');
	});
});

describe('planNoteMove', () => {
	it('moves a root note into a folder', () => {
		expect(planNoteMove('explorer-order.md', 'Maintenance', identity, nothingTaken)).toEqual({ kind: 'move', target: 'Maintenance/explorer-order.md' });
	});

	it('moves a note in a folder back to the root', () => {
		expect(planNoteMove('Maintenance/explorer-order.md', '', identity, nothingTaken)).toEqual({ kind: 'move', target: 'explorer-order.md' });
	});

	it('is a no-op for the folder the note is already in, without asking whether the target is taken', () => {
		// The target *is* taken — by the note itself. Asking would turn
		// "already there" into a refusal naming the note as the obstacle.
		const isTaken = (): boolean => {
			throw new Error('must not be asked');
		};
		expect(planNoteMove('Maintenance/explorer-order.md', 'Maintenance', identity, isTaken)).toEqual({ kind: 'same-folder' });
		expect(planNoteMove('explorer-order.md', '', identity, isTaken)).toEqual({ kind: 'same-folder' });
	});

	it('treats a folder whose path merely starts with the current one as a different folder', () => {
		expect(planNoteMove('Projects/explorer-order.md', 'ProjectsOld', identity, nothingTaken)).toEqual({
			kind: 'move',
			target: 'ProjectsOld/explorer-order.md',
		});
		expect(planNoteMove('Projects/explorer-order.md', 'Projects/Sub', identity, nothingTaken)).toEqual({
			kind: 'move',
			target: 'Projects/Sub/explorer-order.md',
		});
	});

	it('refuses when the target path is taken, and names it', () => {
		const taken = new Set(['Maintenance/explorer-order.md']);
		expect(planNoteMove('explorer-order.md', 'Maintenance', identity, (path) => taken.has(path))).toEqual({
			kind: 'taken',
			target: 'Maintenance/explorer-order.md',
		});
	});

	it('asks isTaken about the normalized target, and returns that same path to move to', () => {
		const normalize = (path: string): string => path.normalize('NFC');
		const nfdFolder = 'Café';
		const nfcTarget = 'Café/explorer-order.md';
		const asked: string[] = [];
		const plan = planNoteMove('explorer-order.md', nfdFolder, normalize, (path) => {
			asked.push(path);
			return false;
		});
		expect(asked).toEqual([nfcTarget]);
		expect(plan).toEqual({ kind: 'move', target: nfcTarget });
	});
});

describe('folderChoices', () => {
	const pathOf = (path: string): string => path;

	it('leaves out the folder the note is already in, and only that one', () => {
		expect(folderChoices(['', 'Maintenance', 'Maintenance/Sub', 'MaintenanceOld'], pathOf, 'Maintenance/explorer-order.md')).toEqual([
			'',
			'Maintenance/Sub',
			'MaintenanceOld',
		]);
	});

	it('leaves out the root for a root-level note', () => {
		expect(folderChoices(['B', '', 'A'], pathOf, 'explorer-order.md')).toEqual(['A', 'B']);
	});

	it('lists the root first and the rest by path', () => {
		expect(folderChoices(['Zeta', 'alpha', '', 'Beta/inner', 'Beta'], pathOf, 'Elsewhere/order.md')).toEqual(['', 'alpha', 'Beta', 'Beta/inner', 'Zeta']);
	});

	it('orders an NFC/NFD pair the same whatever order they arrive in', () => {
		const nfc = 'café';
		const nfd = 'café';
		const one = folderChoices([nfc, nfd], pathOf, 'order.md');
		const other = folderChoices([nfd, nfc], pathOf, 'order.md');
		expect(one).toEqual(other);
	});

	it('does not reorder the array it is given', () => {
		const input = ['B', 'A'];
		folderChoices(input, pathOf, 'order.md');
		expect(input).toEqual(['B', 'A']);
	});
});

describe('noteLocationRow', () => {
	it('can move an existing note, and says where it is', () => {
		const row = noteLocationRow({ notePath: 'Maintenance/explorer-order.md', noteInVault: true, settingsDefaulted: false, keptCopies: 0 });
		expect(row.canMove).toBe(true);
		expect(row.desc).toContain('Maintenance/explorer-order.md');
	});

	it('cannot move a note that is not in the vault, and says it will be created there', () => {
		const row = noteLocationRow({ notePath: 'explorer-order.md', noteInVault: false, settingsDefaulted: false, keptCopies: 0 });
		expect(row.canMove).toBe(false);
		expect(row.desc).toContain('explorer-order.md');
		expect(row.desc).toContain('created there the next time an order is saved');
	});

	it('cannot move while settings are defaulted, even when a note is at the default path', () => {
		// The case that matters: a note *is* at the default path, so the
		// existence check alone would allow it — but the move could not be
		// saved, and the real `indexPath` would come back without it.
		const row = noteLocationRow({ notePath: 'explorer-order.md', noteInVault: true, settingsDefaulted: true, keptCopies: 0 });
		expect(row.canMove).toBe(false);
		expect(row.desc).toContain('settings cannot be read');
	});

	it('reports defaulted settings rather than a missing note when both hold', () => {
		const row = noteLocationRow({ notePath: 'explorer-order.md', noteInVault: false, settingsDefaulted: true, keptCopies: 0 });
		expect(row.canMove).toBe(false);
		expect(row.desc).toContain('settings cannot be read');
		expect(row.desc).not.toContain('created there');
	});

	it('cannot move while kept copies are beside the note, and says why', () => {
		const one = noteLocationRow({ notePath: 'explorer-order.md', noteInVault: true, settingsDefaulted: false, keptCopies: 1 });
		expect(one.canMove).toBe(false);
		expect(one.desc).toContain('a kept copy of an unreadable version is beside it');
		const two = noteLocationRow({ notePath: 'explorer-order.md', noteInVault: true, settingsDefaulted: false, keptCopies: 2 });
		expect(two.canMove).toBe(false);
		expect(two.desc).toContain('2 kept copies of an unreadable version are beside it');
	});

	it('reports a missing note rather than kept copies when both hold', () => {
		const row = noteLocationRow({ notePath: 'explorer-order.md', noteInVault: false, settingsDefaulted: false, keptCopies: 1 });
		expect(row.canMove).toBe(false);
		expect(row.desc).toContain('created there');
		expect(row.desc).not.toContain('kept cop');
	});
});
