/**
 * Runs before every test file (`test.setupFiles`, `vitest.config.ts`).
 *
 * `installTimers` used to be each store-backed test file's own job to
 * remember, and the file that forgot found out only when its first test drove
 * a mutation through a real store — `window` is reached by `scheduleWrite`
 * and `markUnusable`, not by importing the stub, so the omission stayed
 * invisible until exactly the test that mattered. Installing here once means
 * a new test file cannot re-open that gap. Idempotent (`??=` in the stub), so
 * running before files that never touch a store costs nothing.
 */
import { installTimers } from './stubs/obsidian';

installTimers();
