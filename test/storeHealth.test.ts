/**
 * The store's usable/unusable transitions (`src/storeHealth.ts`), enumerated.
 * Each case is an invariant that used to live only in prose across five
 * mutable fields; the E2-shaped rows (evidence stickiness, evidence required
 * on entry) are the reason the module exists.
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_HEALTH, madeUnusable, madeUsable } from '../src/storeHealth';

describe('madeUsable', () => {
	it('records proven-block evidence and keeps it across later transitions (sticky)', () => {
		const proven = madeUsable(INITIAL_HEALTH, true);
		expect(proven.sawBlock).toBe(true);

		// A later entry into usable that proves nothing must not erase what an
		// earlier read proved — the question is "has a block EVER been seen".
		expect(madeUsable(proven, false).sawBlock).toBe(true);
		const { health: broken } = madeUnusable(proven, 'Its json block is missing', 'block-less text');
		expect(broken.sawBlock).toBe(true);
		expect(madeUsable(broken, false).sawBlock).toBe(true);
	});

	it('does not invent evidence: false stays false until something proves a block', () => {
		expect(madeUsable(INITIAL_HEALTH, false).sawBlock).toBe(false);
	});

	it('structurally drops the unreadable text: the usable arm has no such field', () => {
		const { health: broken } = madeUnusable(INITIAL_HEALTH, 'Malformed JSON: x', 'the only copy');
		const healed = madeUsable(broken, true);
		expect('lastUnreadableText' in healed).toBe(false);
		expect('reason' in healed).toBe(false);
	});
});

describe('madeUnusable', () => {
	it('carries reason and the judged text, and asks for the Notice on a fresh break', () => {
		const { health, firstNotice } = madeUnusable(INITIAL_HEALTH, 'Malformed JSON: x', 'bad bytes');
		expect(firstNotice).toBe(true);
		expect(health.reason).toBe('Malformed JSON: x');
		expect(health.lastUnreadableText).toBe('bad bytes');
		expect(health.noticeShown).toBe(true);
	});

	it('stays quiet when re-marking an already-noticed stretch, but adopts the newer text', () => {
		const first = madeUnusable(INITIAL_HEALTH, 'Malformed JSON: x', 'older bad bytes');
		const second = madeUnusable(first.health, 'Its json block is missing', 'newer bad bytes');
		expect(second.firstNotice).toBe(false);
		// The newer judgment wins on both counts — reason and kept text.
		expect(second.health.reason).toBe('Its json block is missing');
		expect(second.health.lastUnreadableText).toBe('newer bad bytes');
	});

	it('speaks again on the first break after a recovery — one Notice per stretch, not per session', () => {
		const first = madeUnusable(INITIAL_HEALTH, 'Malformed JSON: x', 'bad');
		const healed = madeUsable(first.health, true);
		const again = madeUnusable(healed, 'Malformed JSON: y', 'bad again');
		expect(again.firstNotice).toBe(true);
	});
});
