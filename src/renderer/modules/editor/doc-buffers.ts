// Pomade — a doc tab's LIVE buffer, reachable from outside its pane. Each mounted EditorPane
// registers a channel for its tab: the Cmd+Shift+G quick peek reads the buffer (E-035); the
// comparison tab (E-037) reads and edits it, follows its state, and saves through it — so a doc and
// its comparison share ONE buffer, one dirty flag and one save path. The pane owns the buffer; a
// channel only forwards.

/** What another view needs to mirror a doc tab's state (the rule-8 notices included). */
export interface DocChannelState {
  loaded: boolean
  dirty: boolean
  /** Another writer changed the file since the buffer's sync point (rule 8). */
  changedOutside: boolean
  missing: boolean
  /** The file was refused (binary / too big): there is no buffer to share. */
  refused: boolean
}

export interface DocChannel {
  tabId: string
  projectId: string
  path(): string
  /** The live buffer (pending editor edits flushed first). */
  read(): string
  state(): DocChannelState
  /** An edit made in another view: replaces the buffer as an unsaved edit; the doc's own editor
   *  follows. */
  write(next: string): void
  /** Cmd+S from another view: saves silently when nothing needs a decision; otherwise brings the
   *  doc's own tab forward and runs its save there, so its dialogs (conflict, outside the
   *  workspace) show where they live. */
  save(): Promise<void>
  /** The rule-8 notice actions, as the doc tab offers them. */
  reload(): void
  dismissChange(): void
  /** Keep mine: the current disk becomes the base; the buffer stays as unsaved edits. */
  keepMine(): Promise<void>
  /** Load the disk version; the unsaved state is kept as a discarded draft. */
  loadDisk(): void
  /** Called on every buffer or state change. Returns unsubscribe. */
  subscribe(fn: () => void): () => void
}

const channels = new Map<string, DocChannel>()
const registryListeners = new Set<() => void>()

function announce(): void {
  for (const fn of [...registryListeners]) fn()
}

export function registerDocChannel(channel: DocChannel): () => void {
  channels.set(channel.tabId, channel)
  announce()
  return () => {
    if (channels.get(channel.tabId) === channel) {
      channels.delete(channel.tabId)
      announce()
    }
  }
}

/** The tab's current buffer, or null when no pane is mounted for it. */
export function readDocBuffer(tabId: string): string | null {
  return channels.get(tabId)?.read() ?? null
}

/** The mounted doc tab for `path` in `projectId`, if any. */
export function findDocChannel(projectId: string, path: string): DocChannel | null {
  for (const ch of channels.values()) if (ch.projectId === projectId && ch.path() === path) return ch
  return null
}

/** Every mounted doc tab for `path`, in any project. */
export function findDocChannelsFor(path: string): DocChannel[] {
  return [...channels.values()].filter((ch) => ch.path() === path)
}

/** Be told when a doc pane mounts or unmounts (or retargets). Returns unsubscribe. */
export function onDocChannels(fn: () => void): () => void {
  registryListeners.add(fn)
  return () => {
    registryListeners.delete(fn)
  }
}

/** A pane announces a retarget (rename / Save As) so lookups by path see the new one. */
export const announceDocChannels = announce
