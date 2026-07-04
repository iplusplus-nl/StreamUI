import { Check, Search, X } from "lucide-react";

type ModelImportDialogProps = {
  models: string[];
  selectedModels: string[];
  query: string;
  isLoading: boolean;
  error: string | null;
  onQueryChange(query: string): void;
  onToggleModel(modelId: string): void;
  onClose(): void;
  onAddSelected(): void;
};

export function ModelImportDialog({
  models,
  selectedModels,
  query,
  isLoading,
  error,
  onQueryChange,
  onToggleModel,
  onClose,
  onAddSelected
}: ModelImportDialogProps) {
  const normalizedQuery = query.trim().toLowerCase();
  const selectedSet = new Set(selectedModels.map((model) => model.toLowerCase()));
  const filteredModels = normalizedQuery
    ? models.filter((model) => model.toLowerCase().includes(normalizedQuery))
    : models;

  return (
    <div className="model-import-overlay" role="presentation">
      <section
        className="model-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import models"
      >
        <header className="model-import-header">
          <div>
            <h3>Import models</h3>
            <p>{models.length} models found</p>
          </div>
          <button
            className="model-import-icon-button"
            type="button"
            aria-label="Close model importer"
            onClick={onClose}
          >
            <X size={16} strokeWidth={2.1} aria-hidden="true" />
          </button>
        </header>

        <label className="model-import-search">
          <Search size={15} strokeWidth={2.1} aria-hidden="true" />
          <input
            value={query}
            autoFocus
            placeholder="Search models"
            spellCheck={false}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>

        <div className="model-import-list" role="listbox" aria-multiselectable>
          {isLoading ? (
            <div className="model-import-empty">Fetching models...</div>
          ) : error ? (
            <div className="model-import-error">{error}</div>
          ) : filteredModels.length ? (
            filteredModels.map((model) => {
              const isSelected = selectedSet.has(model.toLowerCase());

              return (
                <button
                  key={model}
                  className={`model-import-row ${isSelected ? "is-selected" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onToggleModel(model)}
                >
                  <span>{model}</span>
                  {isSelected ? (
                    <Check size={17} strokeWidth={2.1} aria-hidden="true" />
                  ) : null}
                </button>
              );
            })
          ) : (
            <div className="model-import-empty">No matching models</div>
          )}
        </div>

        <footer className="model-import-footer">
          <button className="settings-secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="settings-primary-button"
            type="button"
            disabled={!selectedModels.length}
            onClick={onAddSelected}
          >
            <Check size={16} strokeWidth={2.1} aria-hidden="true" />
            <span>Add selected</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
