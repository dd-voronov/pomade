// Test-tunable main-process intervals (T-177).
//
// The e2e suite waits on a handful of main-process poll/debounce windows. Encoding those
// production intervals as literal sleeps made specs both slow (a serial heavy pass pays every
// millisecond) and fragile (a sleep sized "just past" an interval loses under load). Instead,
// each such interval resolves through `tunedMs`: production code keeps its constant, and an e2e
// run shrinks the window via a `POMADE_TEST_*` env var (docs/contracts/test-hooks.md).
//
// Contract: with the env var unset — or set to anything but a positive finite number of
// milliseconds (an empty string is a spec's per-launch opt-OUT back to production timing) — the
// production value is returned untouched. Read once at module init of the caller, like every
// other main-process interval constant.

export function tunedMs(envVar: string, productionMs: number): number {
  const raw = process.env[envVar]
  if (raw === undefined || raw === '') return productionMs
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : productionMs
}
