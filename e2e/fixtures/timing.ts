// Pomade e2e — shared timing helpers (T-177 sleep diet).
//
// The suite used to encode main-process poll/debounce intervals as literal sleeps sized to the
// PRODUCTION constants — pure wall-clock on the serial heavy pass, and fragile under load. Two
// mechanisms replace them:
//
// 1. TUNED INTERVALS. playwright.config.ts exports the POMADE_TEST_* values below into
//    process.env; every spec's `electron.launch` spreads `...process.env`, so each app under
//    test runs its poll/debounce windows at these shrunk values (docs/contracts/test-hooks.md). A
//    spec that must run one app at PRODUCTION timing (e.g. the submit-tie /
//    file-pairing specs, whose subject is what lands within one poll tick) opts out per launch:
//    `env: { ...process.env, POMADE_TEST_POLL_MS: '' }` — an empty value means "unset".
//
// 2. QUIET WINDOWS. A negative assertion ("nothing may adopt the bogus id", "no second write")
//    can never poll for its subject — it must HOLD a condition for a window in which the
//    forbidden action had every opportunity to fire. `expectQuiet` polls the condition
//    throughout the window (a violation fails in ~one poll step instead of after the sleep),
//    and `quietWindow` sizes the window as a multiple of the (tuned) interval it guards, so the
//    safety margin is preserved when the interval shrinks. Windows guarding real-world timing
//    (zsh startup, TUI paint, clipboard, powerMonitor) are NOT interval-derived — those keep
//    their empirically-sized values.
//
// Scope note: this module is timing only. launchApp/fake-agent consolidation is T-161.

/** Tuned main-process intervals for e2e runs (production values in parentheses). */
export const TEST_POLL_MS = 250 // session-watcher POLL_MS (1000)
export const TEST_SNAPSHOT_IDLE_MS = 250 // pty-manager SNAPSHOT_IDLE_MS (2000)
export const TEST_CONFIG_DEBOUNCE_MS = 100 // config-store DEBOUNCE_MS (500)

/** What playwright.config.ts exports into process.env for every launched app. */
export const TEST_TUNING_ENV: Record<string, string> = {
  POMADE_TEST_POLL_MS: String(TEST_POLL_MS),
  POMADE_TEST_SNAPSHOT_IDLE_MS: String(TEST_SNAPSHOT_IDLE_MS),
  POMADE_TEST_CONFIG_DEBOUNCE_MS: String(TEST_CONFIG_DEBOUNCE_MS)
}

/** Size a quiet window: `ticks` full intervals for the guarded mechanism to fire in, plus a
 *  fixed scheduling margin (event-loop + IPC + fs latency of the tick's own work). Keep `ticks`
 *  at least as large as the multiple the original production-sized sleep used. */
export function quietWindow(intervalMs: number, ticks: number): number {
  return ticks * intervalMs + 250
}

/** Assert `check` holds NOW and keeps holding for `windowMs`. The check is re-run every
 *  `stepMs`, so a violation fails fast (with the violating state visible) instead of being
 *  discovered after a blind sleep. Use for negative assertions only — a positive wait ("X
 *  eventually appears") is `expect.poll` / `toPass` on the condition itself. */
export async function expectQuiet(
  check: () => void | Promise<void>,
  windowMs: number,
  stepMs = 100
): Promise<void> {
  const deadline = Date.now() + windowMs
  for (;;) {
    await check()
    const left = deadline - Date.now()
    if (left <= 0) return
    await new Promise((r) => setTimeout(r, Math.min(stepMs, left)))
  }
}
