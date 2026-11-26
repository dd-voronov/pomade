// Pomade — agent command check (pure logic; the shell runner is injected).
//
// The roster asks "does this agent's command start anything in the user's interactive login
// shell?" — aliases and functions count, so the answer comes from `zsh -ilc`. One shell checks a
// whole roster: the command words travel as positional arguments (never spliced into the
// script), and the script prints one marker line per word with `whence`'s exit status.
//
// A roster build waits for the shell only briefly (`waitMs`): a word still being checked then is
// `unknown`, and the shell's answer, when it comes, serves the next build — so a slow login shell
// never holds up the "+" menu or a tab revive.
//
// Three outcomes. `found` is cached for the app run. `not-found` (the shell answered "no") and
// `unknown` (the shell timed out, was killed or never reported — e.g. a slow first start) are
// never cached: the next roster build asks again. Only `not-found` marks an agent unresolved, so
// a check that could not finish never shows the user a false "not mapped".

export type CheckOutcome = 'found' | 'not-found' | 'unknown'

export interface ShellRun {
  stdout: string
  stderr: string
  /** The shell's exit code; null when it was killed or never started. */
  code: number | null
  signal: string | null
  timedOut: boolean
  /** Set when the shell could not be started at all. */
  error?: string
}

/** Runs `zsh -ilc <script> <argv0> ...words` and reports what came back. */
export type RunShell = (script: string, words: string[]) => Promise<ShellRun>

export const CHECK_MARKER = '__POMADE_AGENT_CHECK__'

/** One marker line per positional argument: `<marker> <1-based index> <whence exit status>`. */
export const CHECK_SCRIPT =
  `integer _pomade_i=0; for _pomade_w in "$@"; do (( _pomade_i++ )); ` +
  `builtin whence -- "$_pomade_w" >/dev/null 2>&1; ` +
  `builtin print -r -- "${CHECK_MARKER} $_pomade_i $?"; done`

/** The word the shell has to know: the command's first word (`codex --full-auto` ⇒ `codex`),
 *  the same word in-shell detection matches on. */
export function commandWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

/** The `whence` exit status per word (by position); null for a word the shell never reported. */
export function parseCheckOutput(stdout: string, count: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(count).fill(null)
  for (const line of stdout.split('\n')) {
    const m = new RegExp(`^${CHECK_MARKER} (\\d+) (\\d+)\\s*$`).exec(line)
    if (!m) continue
    const index = Number(m[1]) - 1
    if (index >= 0 && index < count) out[index] = Number(m[2])
  }
  return out
}

/** An unresolved agent is one whose check answered "not found" — never one that is unknown. */
export function isResolved(outcome: CheckOutcome): boolean {
  return outcome !== 'not-found'
}

const STDERR_HEAD = 300

function why(run: ShellRun, timeoutMs: number): string {
  if (run.error) return `shell did not start: ${run.error}`
  if (run.timedOut) return `timed out after ${timeoutMs} ms`
  if (run.signal) return `shell killed by ${run.signal}`
  return `shell exited ${run.code ?? '?'} before reporting`
}

export interface CommandChecker {
  /** The outcome per command string (commands sharing a first word share one check). With
   *  `waitMs`, a word whose shell has not answered by then is `unknown` — the shell keeps running,
   *  and its answer serves the next call. */
  check(commands: string[], waitMs?: number): Promise<Map<string, CheckOutcome>>
  /** Drop what is known about a command's word (a remap re-checks it fresh). */
  forget(command: string): void
}

export function createCommandChecker(opts: {
  run: RunShell
  log: (line: string) => void
  timeoutMs: number
}): CommandChecker {
  const found = new Set<string>()
  const inflight = new Map<string, Promise<CheckOutcome>>()
  /** Words whose current failure is already in the log — one line per failure, not per call. */
  const logged = new Set<string>()

  const report = (word: string, outcome: CheckOutcome, detail: string, stderr: string): void => {
    if (logged.has(word)) return
    logged.add(word)
    const head = stderr.replace(/\s+/g, ' ').trim().slice(0, STDERR_HEAD)
    opts.log(
      `[agents] command check: ${JSON.stringify(word)} ${outcome} — ${detail}` + (head ? `; stderr: ${head}` : '')
    )
  }

  const runBatch = async (words: string[]): Promise<Map<string, CheckOutcome>> => {
    const run = await opts.run(CHECK_SCRIPT, words).catch(
      (err: unknown): ShellRun => ({ stdout: '', stderr: '', code: null, signal: null, timedOut: false, error: String(err) })
    )
    const statuses = parseCheckOutput(run.stdout, words.length)
    const result = new Map<string, CheckOutcome>()
    words.forEach((word, i) => {
      const status = statuses[i]
      if (status === 0) {
        found.add(word)
        logged.delete(word)
        result.set(word, 'found')
      } else if (status === null || status === undefined) {
        report(word, 'unknown', why(run, opts.timeoutMs), run.stderr)
        result.set(word, 'unknown')
      } else {
        report(word, 'not-found', `whence exit ${status} in the interactive login shell`, run.stderr)
        result.set(word, 'not-found')
      }
    })
    return result
  }

  const outcomeOf = (word: string): Promise<CheckOutcome> | CheckOutcome | undefined => {
    if (word === '') return 'not-found'
    if (found.has(word)) return 'found'
    return inflight.get(word)
  }

  return {
    async check(commands, waitMs) {
      const words = [...new Set(commands.map(commandWord))]
      const pending = words.filter((w) => outcomeOf(w) === undefined)
      if (pending.length > 0) {
        const batch = runBatch(pending)
        for (const w of pending) {
          const p = batch.then((m) => m.get(w) ?? 'unknown')
          inflight.set(w, p)
          void p.finally(() => {
            if (inflight.get(w) === p) inflight.delete(w)
          })
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline =
        waitMs === undefined
          ? null
          : new Promise<CheckOutcome>((resolve) => {
              timer = setTimeout(() => resolve('unknown'), waitMs)
            })
      const byWord = new Map<string, CheckOutcome>()
      await Promise.all(
        words.map(async (w) => {
          const outcome = outcomeOf(w) ?? 'unknown'
          byWord.set(w, await (deadline && typeof outcome !== 'string' ? Promise.race([outcome, deadline]) : outcome))
        })
      )
      clearTimeout(timer)
      return new Map(commands.map((c) => [c, byWord.get(commandWord(c)) ?? 'unknown']))
    },
    forget(command) {
      const word = commandWord(command)
      found.delete(word)
      logged.delete(word)
    }
  }
}
