// Pomade — create/edit a project (Wave 2a; T-031 restructure).
// Create is an EXPLICIT choice between two mutually exclusive shapes (no more base+addon):
//   • "From existing folder" — pick a workspace-relative root, no files copied.
//   • "New from template"     — copy a template folder into <parentDir>/<name>, root = the copy.
// Each option reveals ONLY its own fields, so an invalid combination is impossible by
// construction. Editing never re-copies; it only patches the stored project record.
// E-039 — "Track with git" (TrackWithGit.tsx): a template copy or a folder that does not exist yet
// (created on Create) starts as a repository with a first commit unless unchecked; an existing
// folder without git is offered unchecked. When the first commit cannot be made (git does not know
// who you are), the project is still created and the dialog says why, with what to run.

import { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'

import type { Group, Project } from '@shared/types'
import { normalizeWorkspaceRelPath } from '@shared/paths'
import { useToast } from '../../hooks/useToast'
import { cleanIpcError } from '../../lib/ipc-errors'
import { Modal } from '../../components/Modal'
import {
  Field,
  TextInput,
  TextArea,
  PathPicker,
  Combobox,
  Button
} from '../../components/fields'
import type { GitFailure } from '@shared/git-ops'
import { OpNote } from '../git/ops/OpParts'
import { TrackWithGitRow, useTrackWithGit } from '../git/ops/TrackWithGit'
import { IconPicker } from './IconPicker'
import { useAgentRoster } from './agents-detect'
import styles from './ProjectModal.module.css'

interface ProjectModalProps {
  project?: Project
  groups: Group[]
  /** Existing projects — used for area suggestions and next order. */
  projects: Project[]
  /** Preselected group when launched from a group's "+". */
  defaultGroupId?: string
  /** T-182 — pre-fill the existing-folder root path (workspace-relative) when launched from the
   *  file tree's "Start new project from here". Read once on mount; create-only. */
  initialRootPath?: string
  /** T-182 — preselect the create shape on mount (create-only). Defaults to 'existing'. */
  initialCreateMode?: 'existing' | 'template'
  onSave: (project: Project) => void
  onClose: () => void
}

function joinRel(parent: string, name: string): string {
  const p = parent.replace(/\/+$/, '')
  return p ? `${p}/${name}` : name
}

export function ProjectModal({
  project,
  groups,
  projects,
  defaultGroupId,
  initialRootPath,
  initialCreateMode,
  onSave,
  onClose
}: ProjectModalProps): React.JSX.Element {
  const editing = Boolean(project)
  const toast = useToast()
  const { available: agentsAvailable, agents } = useAgentRoster()

  const [name, setName] = useState(project?.name ?? '')
  const [groupId, setGroupId] = useState<string>(project?.groupId ?? defaultGroupId ?? '')
  // T-182 — on create, `initialRootPath` seeds the field (file-tree "Start new project from here");
  // editing shows the project's current root, editable.
  const [rootPath, setRootPath] = useState(project?.rootPath ?? initialRootPath ?? '')
  // T-031 — the create shape is an explicit, mutually exclusive choice. Editing has no choice
  // (it shows the Root folder field), so this state is only consulted on create.
  // T-182 — `initialCreateMode` preselects it on mount (still defaults to 'existing').
  const [createMode, setCreateMode] = useState<'existing' | 'template'>(
    initialCreateMode ?? 'existing'
  )
  const [templateRel, setTemplateRel] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [area, setArea] = useState(project?.area ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [image, setImage] = useState(project?.image ?? '')
  const [icon, setIcon] = useState(project?.icon ?? '')
  const [visibleAgents, setVisibleAgents] = useState<string[]>(project?.visibleAgents ?? ['*'])
  const [busy, setBusy] = useState(false)
  /** The project was created, but its first commit was not made: why, until Done. */
  const [initFailure, setInitFailure] = useState<{ name: string; failure: GitFailure } | null>(null)

  // Default the template parent dir to Projects/ when it exists.
  useEffect(() => {
    if (editing) return
    void window.pomade.fs.exists('Projects').then((ok) => {
      if (ok) setParentDir('Projects')
    })
  }, [editing])

  const areaSuggestions = useMemo(
    () => [...new Set(projects.map((p) => p.area).filter((a): a is string => Boolean(a)))].sort(),
    [projects]
  )

  const usingTemplate = !editing && createMode === 'template'
  const git = useTrackWithGit(createMode, rootPath, !editing)
  const canSave =
    name.trim().length > 0 &&
    (usingTemplate ? templateRel.trim().length > 0 : rootPath.trim().length > 0)

  const allAgentsSelected = visibleAgents.includes('*')
  const isAgentChecked = (id: string): boolean => allAgentsSelected || visibleAgents.includes(id)
  const toggleAgent = (id: string): void => {
    const base = allAgentsSelected ? agents.map((a) => a.id) : visibleAgents
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    setVisibleAgents(next.length === agents.length ? ['*'] : next)
  }

  const submit = async (): Promise<void> => {
    if (!canSave || busy) return
    setBusy(true)
    try {
      // T-064 — normalize the hand-typed root so a leading '/' (and stray trailing/repeated
      // slashes) can't produce a workspace-relative rootPath that the file tree treats as an
      // escape (empty tree) while reveal-in-finder still resolves it.
      let finalRoot = normalizeWorkspaceRelPath(rootPath)
      if (usingTemplate) {
        finalRoot = joinRel(normalizeWorkspaceRelPath(parentDir), name.trim())
        if (await window.pomade.fs.exists(finalRoot)) {
          throw new Error(`Target already exists: ${finalRoot}`)
        }
        await window.pomade.fs.copyDir(normalizeWorkspaceRelPath(templateRel), finalRoot)
      } else if (!editing && git.info?.kind === 'missing') {
        await window.pomade.fs.createDir(finalRoot)
      }
      const nextOrder = projects.reduce((m, p) => Math.max(m, p.order), -1) + 1
      const result: Project = {
        id: project?.id ?? nanoid(),
        name: name.trim(),
        groupId: groupId || undefined,
        rootPath: finalRoot,
        area: area.trim() || undefined,
        description: description.trim() || undefined,
        image: image.trim() || undefined,
        icon: icon.trim() || undefined,
        visibleAgents,
        order: project?.order ?? nextOrder
      }
      onSave(result)
      if (git.track) {
        const init = await window.pomade.git
          .initRepo(finalRoot, `Start ${result.name}`)
          .catch((err: unknown) => ({ commit: null, failure: { kind: 'other' as const, message: cleanIpcError(err) } }))
        if (init.failure) {
          setInitFailure({ name: result.name, failure: init.failure })
          setBusy(false)
          return
        }
      }
      onClose()
    } catch (err) {
      toast(cleanIpcError(err), 'error')
      setBusy(false)
    }
  }

  if (initFailure) {
    return (
      <Modal
        title="New project"
        onClose={onClose}
        testId="project-modal"
        width={520}
        footer={
          <Button variant="primary" data-testid="project-done" onClick={onClose}>
            Done
          </Button>
        }
      >
        <OpNote
          tone="blocked"
          message={`Created “${initFailure.name}” and started its git repository, but the first commit was not made. ${initFailure.failure.message}`}
          copy={initFailure.failure.copy}
          testId="project-git-failure"
        />
      </Modal>
    )
  }

  return (
    <Modal
      title={editing ? 'Edit project' : 'New project'}
      onClose={onClose}
      testId="project-modal"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canSave || busy}
            data-testid="project-save"
            onClick={() => void submit()}
          >
            {editing ? 'Save' : 'Create project'}
          </Button>
        </>
      }
    >
      <Field label="Name">
        <TextInput
          value={name}
          autoFocus
          placeholder="e.g. Alpha"
          data-testid="project-name"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <Field label="Group">
        <select
          className={styles.select}
          value={groupId}
          data-testid="project-group"
          onChange={(e) => setGroupId(e.target.value)}
        >
          <option value="">Ungrouped</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </Field>

      {/* T-031 — editing: the Root folder field only; there is no source choice. */}
      {editing && (
        <Field label="Root folder" hint="Workspace-relative folder this project is rooted at.">
          <PathPicker
            value={rootPath}
            onChange={setRootPath}
            directory
            placeholder="e.g. Projects/alpha"
            testId="project-root"
          />
        </Field>
      )}

      {/* T-031 — create: an explicit, mutually exclusive choice. Each card reveals only its
          own fields, so "existing folder" and "template copy" can never be combined. */}
      {!editing && (
        <Field label="Project source">
          <div className={styles.sourceCards} role="radiogroup" aria-label="Project source">
            <label
              className={`${styles.sourceCard} ${createMode === 'existing' ? styles.sourceCardActive : ''}`}
              data-testid="create-mode-existing"
              data-active={createMode === 'existing'}
            >
              <input
                type="radio"
                name="project-source"
                checked={createMode === 'existing'}
                onChange={() => setCreateMode('existing')}
              />
              <span className={styles.sourceCardBody}>
                <span className={styles.sourceCardTitle}>From existing folder</span>
                <span className={styles.sourceCardHint}>
                  Root this project at a folder already in the workspace.
                </span>
              </span>
            </label>
            <label
              className={`${styles.sourceCard} ${createMode === 'template' ? styles.sourceCardActive : ''}`}
              data-testid="create-mode-template"
              data-active={createMode === 'template'}
            >
              <input
                type="radio"
                name="project-source"
                checked={createMode === 'template'}
                onChange={() => setCreateMode('template')}
              />
              <span className={styles.sourceCardBody}>
                <span className={styles.sourceCardTitle}>New from template</span>
                <span className={styles.sourceCardHint}>
                  Copy a template folder into a parent; the copy becomes the root.
                </span>
              </span>
            </label>
          </div>
        </Field>
      )}

      {!editing && createMode === 'existing' && (
        <Field label="Root folder" hint="Workspace-relative folder this project is rooted at.">
          <PathPicker
            value={rootPath}
            onChange={setRootPath}
            directory
            placeholder="e.g. Projects/alpha"
            testId="project-root"
          />
        </Field>
      )}
      {!editing && createMode === 'existing' && <TrackWithGitRow git={git} />}

      {!editing && createMode === 'template' && (
        <fieldset className={styles.templateBox}>
          <legend className={styles.legend}>New from template</legend>
          <Field label="Template folder" hint="A folder inside the workspace to copy.">
            <PathPicker
              value={templateRel}
              onChange={setTemplateRel}
              directory
              placeholder="e.g. Templates/basic-project"
              testId="project-template"
            />
          </Field>
          <Field label="Parent folder" hint="The copy is created as <parent>/<name>.">
            <PathPicker
              value={parentDir}
              onChange={setParentDir}
              directory
              placeholder="e.g. Projects"
              testId="project-parent"
            />
          </Field>
          <TrackWithGitRow git={git} />
        </fieldset>
      )}

      <Field label="Area">
        <Combobox
          value={area}
          onChange={setArea}
          suggestions={areaSuggestions}
          placeholder="suggests areas from other projects; free text ok"
          testId="project-area"
        />
      </Field>

      <Field label="Description">
        <TextArea
          value={description}
          placeholder="(optional)"
          data-testid="project-description"
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <Field label="Icon">
        <IconPicker
          icon={icon}
          image={image}
          onIconChange={setIcon}
          onImageChange={setImage}
          defaultGlyph="📄"
          testIdPrefix="project"
        />
      </Field>

      <Field label="Visible agents">
        {agentsAvailable ? (
          <div className={styles.agentList} data-testid="project-agents">
            <label className={styles.agentRow}>
              <input
                type="checkbox"
                checked={allAgentsSelected}
                onChange={() => setVisibleAgents(allAgentsSelected ? [] : ['*'])}
              />
              <span>All agents</span>
            </label>
            {agents.map((a) => (
              <label key={a.id} className={styles.agentRow}>
                <input
                  type="checkbox"
                  checked={isAgentChecked(a.id)}
                  disabled={allAgentsSelected}
                  onChange={() => toggleAgent(a.id)}
                />
                <span>{a.name}</span>
                {!a.resolved && <span className={styles.agentWarn}>unresolved</span>}
              </label>
            ))}
          </div>
        ) : (
          <span className={styles.agentsHint} data-testid="project-agents-hint">
            Agent roster loads once terminals ship; all agents will be visible for now.
          </span>
        )}
      </Field>
    </Modal>
  )
}
