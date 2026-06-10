import type { ProjectListItem } from '@geulbat/protocol/projects';

interface Props {
  projects: ProjectListItem[];
  selectedProjectId: string;
  disabled: boolean;
  uiError?: string | null;
  helperText?: string | null;
  onSelect: (projectId: string) => void;
}

export function ProjectSelector({
  projects,
  selectedProjectId,
  disabled,
  uiError,
  helperText,
  onSelect,
}: Props) {
  return (
    <section className="project-selector">
      <label
        className="project-selector-label"
        htmlFor="project-selector-input"
      >
        Current project
      </label>
      <select
        id="project-selector-input"
        className="project-selector-input"
        value={selectedProjectId}
        disabled={disabled || projects.length === 0}
        onChange={(event) => onSelect(event.currentTarget.value)}
      >
        {projects.map((project) => (
          <option key={project.projectId} value={project.projectId}>
            {project.label}
          </option>
        ))}
      </select>
      {helperText ? (
        <p className="project-selector-note" role="status">
          {helperText}
        </p>
      ) : null}
      {uiError ? (
        <div className="project-selector-error" role="alert">
          {uiError}
        </div>
      ) : null}
    </section>
  );
}
