/**
 * The rebuild-attempt decision table (`src/rebuildStep.ts`), enumerated.
 *
 * Every row here used to be a path through `quarantineThenRebuild` that only
 * hand testing could reach; the point of the table is that the next member
 * added to it shows up as a failing enumeration rather than a branch nobody
 * thought to walk. The precedence cases matter as much as the rows: adopt
 * beats everything, a missing plan beats the unindexed check, and the
 * unindexed check fires before any quarantine could be taken.
 */
import { describe, expect, it } from 'vitest';
import { parseIndex } from '../src/orderIndex';
import { rebuildStepFor } from '../src/rebuildStep';

const okParse = parseIndex('```json\n{\n  "navtest": ["a.md"]\n}\n```\n');
const invalidParse = parseIndex('```json\n{ totally broken }\n```\n');
const emptyParse = parseIndex('just prose, no fence\n');

/** Stands in for the caller's RebuildPlan; the decision never looks inside it. */
const plan = { marker: 'plan' } as const;

describe('rebuildStepFor', () => {
	it('adopts a note that parses cleanly, handing back the parsed index', () => {
		const step = rebuildStepFor(okParse, null, 'whatever bytes', true);
		expect(step.kind).toBe('adopt');
		if (step.kind !== 'adopt') return;
		expect([...step.index.keys()]).toEqual(['navtest']);
	});

	it('adopt wins regardless of plan, disk state, or indexing', () => {
		// The parse succeeding means the note is strictly newer truth than any
		// plan derived from a broken version — nothing else may outrank it.
		for (const noteText of ['bytes', '', null]) {
			for (const indexed of [true, false]) {
				expect(rebuildStepFor(okParse, plan, noteText, indexed).kind).toBe('adopt');
			}
		}
	});

	it('stops with nothing-to-recover when there is no plan, before the unindexed check', () => {
		// Precedence: with nothing to write, whether the note could be written
		// atomically is moot — and answering 'gave-up-unindexed' instead would
		// make the settings tab report a retryable failure where the honest
		// answer is the start-over offer.
		expect(rebuildStepFor(invalidParse, null, 'bytes', false).kind).toBe('nothing-to-recover');
		expect(rebuildStepFor(invalidParse, null, 'bytes', true).kind).toBe('nothing-to-recover');
		expect(rebuildStepFor(emptyParse, null, null, false).kind).toBe('nothing-to-recover');
	});

	it('gives up before quarantining when the note is on disk but not indexed (E1)', () => {
		expect(rebuildStepFor(invalidParse, plan, 'bytes on disk', false).kind).toBe('gave-up-unindexed');
	});

	it('does not treat an absent note as unindexed — absence means create, not give up', () => {
		// `noteText === null` is the adapter's own word that the note is gone;
		// the file map having no handle for a nonexistent file is not a fault.
		const step = rebuildStepFor(invalidParse, plan, null, false);
		expect(step.kind).toBe('rebuild');
		if (step.kind !== 'rebuild') return;
		expect(step.plan).toBe(plan);
		expect(step.quarantineFirst).toBe(false);
	});

	it('rebuilds with a quarantine first exactly when there are bytes to preserve', () => {
		const withBytes = rebuildStepFor(invalidParse, plan, '```json\nbroken\n```', true);
		expect(withBytes).toEqual({ kind: 'rebuild', plan, quarantineFirst: true });

		// Zero bytes preserve nothing; a copy would only be a note the
		// "delete the kept copies" row then offers to tidy away.
		const emptyFile = rebuildStepFor(emptyParse, plan, '', true);
		expect(emptyFile).toEqual({ kind: 'rebuild', plan, quarantineFirst: false });
	});
});
