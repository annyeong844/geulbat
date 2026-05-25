import { useState, type FormEvent } from 'react';
import {
  getProjectRegistryDeleteDescription,
  getSelectedProjectDeleteConflictMessage,
  type ProjectListItem,
} from '@geulbat/protocol/projects';

interface Props {
  projects: ProjectListItem[];
  defaultProjectId: string;
  selectedProjectId: string;
  disabled: boolean;
  busy: boolean;
  helperText?: string | null;
  onCreate: (label: string) => Promise<boolean>;
  onRename: (projectId: string, label: string) => Promise<boolean>;
  onDelete: (projectId: string) => Promise<boolean>;
}

export function ProjectRegistryManager({
  projects,
  defaultProjectId,
  selectedProjectId,
  disabled,
  busy,
  helperText,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [createLabel, setCreateLabel] = useState('');
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [pendingDeleteProjectId, setPendingDeleteProjectId] = useState<
    string | null
  >(null);

  const mutationDisabled = disabled || busy;
  const pendingDeleteProject = projects.find(
    (project) => project.projectId === pendingDeleteProjectId,
  );

  async function submitCreate(label: string) {
    const created = await onCreate(label);
    if (created) {
      setCreateLabel('');
    }
  }

  function startRename(project: ProjectListItem) {
    setEditingProjectId(project.projectId);
    setRenameLabel(project.label);
    setPendingDeleteProjectId(null);
  }

  async function submitRename(projectId: string, label: string) {
    const renamed = await onRename(projectId, label);
    if (renamed) {
      setEditingProjectId(null);
      setRenameLabel('');
    }
  }

  async function confirmDelete(projectId: string) {
    const deleted = await onDelete(projectId);
    if (deleted) {
      setPendingDeleteProjectId((current) =>
        current === projectId ? null : current,
      );
    }
  }

  return (
    <section className="project-registry-manager">
      <strong className="project-registry-manager-title">
        Manage projects
      </strong>
      <ProjectRegistryCreateForm
        label={createLabel}
        busy={busy}
        disabled={mutationDisabled}
        onLabelChange={setCreateLabel}
        onCreate={submitCreate}
      />
      {helperText ? (
        <p className="project-registry-note" role="status">
          {helperText}
        </p>
      ) : null}
      <div className="project-registry-list">
        {projects.map((project) => {
          return (
            <ProjectRegistryItem
              key={project.projectId}
              project={project}
              isDefault={project.projectId === defaultProjectId}
              isSelected={project.projectId === selectedProjectId}
              isEditing={project.projectId === editingProjectId}
              mutationDisabled={mutationDisabled}
              renameLabel={renameLabel}
              onRenameLabelChange={setRenameLabel}
              onStartRename={startRename}
              onRename={submitRename}
              onCancelRename={() => {
                setEditingProjectId(null);
                setRenameLabel('');
              }}
              onRequestDelete={setPendingDeleteProjectId}
            />
          );
        })}
      </div>
      {pendingDeleteProject ? (
        <ProjectDeleteConfirm
          project={pendingDeleteProject}
          busy={busy}
          disabled={mutationDisabled}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDeleteProjectId(null)}
        />
      ) : null}
    </section>
  );
}

function ProjectRegistryCreateForm(args: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onLabelChange: (label: string) => void;
  onCreate: (label: string) => Promise<void>;
}) {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await args.onCreate(args.label);
  }

  return (
    <form
      className="project-registry-create"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <input
        className="project-registry-input"
        type="text"
        value={args.label}
        placeholder="New project label"
        disabled={args.disabled}
        onChange={(event) => args.onLabelChange(event.currentTarget.value)}
      />
      <button type="submit" disabled={args.disabled}>
        {args.busy ? 'Saving…' : 'Add project'}
      </button>
    </form>
  );
}

function ProjectRegistryItem(args: {
  project: ProjectListItem;
  isDefault: boolean;
  isSelected: boolean;
  isEditing: boolean;
  mutationDisabled: boolean;
  renameLabel: string;
  onRenameLabelChange: (label: string) => void;
  onStartRename: (project: ProjectListItem) => void;
  onRename: (projectId: string, label: string) => Promise<void>;
  onCancelRename: () => void;
  onRequestDelete: (projectId: string) => void;
}) {
  const deleteBlocked =
    args.isDefault || args.isSelected || args.mutationDisabled;

  return (
    <article className="project-registry-item">
      <div className="project-registry-item-main">
        {args.isEditing ? (
          <ProjectRegistryRenameForm
            projectId={args.project.projectId}
            label={args.renameLabel}
            disabled={args.mutationDisabled}
            onLabelChange={args.onRenameLabelChange}
            onRename={args.onRename}
            onCancel={args.onCancelRename}
          />
        ) : (
          <>
            <div className="project-registry-item-header">
              <strong>{args.project.label}</strong>
              <span className="project-registry-id">
                {args.project.projectId}
              </span>
            </div>
            <div className="project-registry-item-meta">
              {args.isDefault ? (
                <span className="project-registry-badge">default</span>
              ) : null}
              {args.isSelected ? (
                <span className="project-registry-badge">current</span>
              ) : null}
            </div>
            {!args.isDefault || !args.isSelected ? (
              <div className="project-registry-actions">
                {!args.isDefault ? (
                  <button
                    type="button"
                    disabled={args.mutationDisabled}
                    onClick={() => args.onStartRename(args.project)}
                  >
                    Rename
                  </button>
                ) : null}
                {!args.isDefault ? (
                  <button
                    type="button"
                    disabled={deleteBlocked}
                    onClick={() => args.onRequestDelete(args.project.projectId)}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            ) : null}
            {args.isSelected && !args.isDefault ? (
              <p className="project-registry-note" role="status">
                {getSelectedProjectDeleteConflictMessage()}
              </p>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

function ProjectRegistryRenameForm(args: {
  projectId: string;
  label: string;
  disabled: boolean;
  onLabelChange: (label: string) => void;
  onRename: (projectId: string, label: string) => Promise<void>;
  onCancel: () => void;
}) {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await args.onRename(args.projectId, args.label);
  }

  return (
    <form
      className="project-registry-rename"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <input
        className="project-registry-input"
        type="text"
        value={args.label}
        disabled={args.disabled}
        onChange={(event) => args.onLabelChange(event.currentTarget.value)}
      />
      <div className="project-registry-actions">
        <button type="submit" disabled={args.disabled}>
          Save
        </button>
        <button type="button" disabled={args.disabled} onClick={args.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ProjectDeleteConfirm(args: {
  project: ProjectListItem;
  busy: boolean;
  disabled: boolean;
  onConfirm: (projectId: string) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <section className="project-delete-confirm" role="alertdialog">
      <strong>Delete project?</strong>
      <p>
        {args.project.label} will be removed from the project registry.{' '}
        {getProjectRegistryDeleteDescription()}
      </p>
      <div className="project-delete-confirm-actions">
        <button
          type="button"
          disabled={args.disabled}
          onClick={() => void args.onConfirm(args.project.projectId)}
        >
          {args.busy ? 'Deleting…' : 'Delete'}
        </button>
        <button type="button" disabled={args.disabled} onClick={args.onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
