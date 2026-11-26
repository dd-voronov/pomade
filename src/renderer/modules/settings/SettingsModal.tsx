// Pomade E-006 (T-026) — the ONE unified Settings surface. A sectioned dialog: a left nav
// rail (one button per registered section) and the active section's component on the right.
// Mounted once in App; visibility + active section come from settings-store. Reuses the
// shared Modal shell (scrim, Esc-to-close, × button).

import { Modal } from '../../components/Modal'
import { SETTINGS_SECTIONS } from './sections'
import { useSettingsStore } from './settings-store'
import styles from './SettingsModal.module.css'

export function SettingsModal(): React.JSX.Element | null {
  const open = useSettingsStore((s) => s.open)
  const sectionId = useSettingsStore((s) => s.sectionId)
  const setSection = useSettingsStore((s) => s.setSection)
  const closeSettings = useSettingsStore((s) => s.closeSettings)

  if (!open) return null

  const active = SETTINGS_SECTIONS.find((s) => s.id === sectionId) ?? SETTINGS_SECTIONS[0]
  const Section = active.Component

  return (
    <Modal title="Settings" onClose={closeSettings} testId="settings-modal" width={720}>
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`${styles.navItem} ${section.id === active.id ? styles.navActive : ''}`}
              data-testid={`settings-nav-${section.id}`}
              data-active={section.id === active.id}
              onClick={() => setSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>
        <div className={styles.content} data-testid={`settings-content-${active.id}`}>
          <Section />
        </div>
      </div>
    </Modal>
  )
}
