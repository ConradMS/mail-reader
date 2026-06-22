import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModelPicker, StylePicker, Toggle } from "../components/ui";
import { CalendarIcon, BotIcon, TerminalIcon, PencilIcon } from "../components/ui";

type ShowToast = (msg: string, type?: "error" | "success" | "info", duration?: number) => void;

const ACCENT_COLORS = [
  { id: "purple",  label: "Purple",    dark: "#7c6af7", light: "#6b5ae0" },
  { id: "blue",    label: "Blue",      dark: "#3b82f6", light: "#2563eb" },
  { id: "sky",     label: "Sky",       dark: "#0ea5e9", light: "#0284c7" },
  { id: "teal",    label: "Teal",      dark: "#14b8a6", light: "#0d9488" },
  { id: "green",   label: "Green",     dark: "#22c55e", light: "#16a34a" },
  { id: "rose",    label: "Rose",      dark: "#f43f5e", light: "#e11d48" },
  { id: "orange",  label: "Orange",    dark: "#f97316", light: "#ea580c" },
  { id: "amber",   label: "Amber",     dark: "#f59e0b", light: "#d97706" },
] as const;

interface Props {
  showToast: ShowToast;
  accent: string;
  onAccentChange: (a: string) => void;
}

type SaveStatus = "idle" | "saving" | "saved";

interface WritingTemplate {
  id: string;
  name: string;
  instructions: string;
  created_at: string;
}

export function Settings({ showToast, accent, onAccentChange }: Props) {
  // Saved state (what's in DB)
  const [savedLookback, setSavedLookback]   = useState("7");
  const [savedModel, setSavedModel]         = useState("");
  const [savedDebugMode, setSavedDebugMode] = useState(false);

  // Pending state (what's in the UI)
  const [lookback, setLookback]         = useState("7");
  const [ollamaModel, setOllamaModel]   = useState("");
  const [debugMode, setDebugMode]       = useState(false);
  const [models, setModels]             = useState<string[]>([]);
  const [modelStatus, setModelStatus]   = useState<"idle" | "loading" | "error">("idle");
  const [saveStatus, setSaveStatus]     = useState<SaveStatus>("idle");

  // Writing templates
  const [templates, setTemplates]           = useState<WritingTemplate[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string>("");
  const [editingTemplate, setEditingTemplate]   = useState<WritingTemplate | null>(null);
  const [editName, setEditName]                 = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [templateSaving, setTemplateSaving]     = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const isDirty = lookback !== savedLookback || ollamaModel !== savedModel || debugMode !== savedDebugMode;
  const showBar = isDirty || saveStatus === "saved";

  useEffect(() => {
    invoke<Record<string, string>>("get_settings").then(s => {
      const lb  = s.lookback_days ?? "7";
      const mdl = s.ollama_model ?? "";
      const dbg = s.debug_mode === "true";
      setLookback(lb);       setSavedLookback(lb);
      setOllamaModel(mdl);   setSavedModel(mdl);
      setDebugMode(dbg);     setSavedDebugMode(dbg);
      setActiveTemplateId(s.active_template_id ?? "");
      loadModels(mdl);
    }).catch(() => loadModels());

    invoke<WritingTemplate[]>("list_writing_templates").then(setTemplates).catch(() => {});
  }, []);

  useEffect(() => {
    if (editingTemplate !== null) nameInputRef.current?.focus();
  }, [editingTemplate]);

  async function loadModels(currentModel?: string) {
    setModelStatus("loading");
    try {
      const list = await invoke<string[]>("get_ollama_models");
      setModels(list);
      setModelStatus("idle");
      const effective = currentModel ?? ollamaModel;
      if (list.length > 0 && (!effective || !list.includes(effective))) {
        setOllamaModel(list[0]);
      }
    } catch {
      setModelStatus("error");
      setModels([]);
    }
  }

  async function handleSaveAll() {
    setSaveStatus("saving");
    try {
      const lb = Math.max(1, Math.min(90, parseInt(lookback) || 7)).toString();
      setLookback(lb);
      await invoke("set_setting", { key: "lookback_days", value: lb });
      setSavedLookback(lb);

      if (ollamaModel !== savedModel) {
        await invoke("set_setting", { key: "ollama_model", value: ollamaModel });
        invoke("warmup_model").catch(() => {});
        setSavedModel(ollamaModel);
        showToast(`Model set to ${ollamaModel}`, "success");
      }

      if (debugMode !== savedDebugMode) {
        await invoke("set_setting", { key: "debug_mode", value: debugMode ? "true" : "false" });
        setSavedDebugMode(debugMode);
      }

      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (e) {
      showToast(String(e), "error");
      setSaveStatus("idle");
    }
  }

  function handleDiscard() {
    setLookback(savedLookback);
    setOllamaModel(savedModel);
    setDebugMode(savedDebugMode);
  }

  async function handleSetActive(id: string) {
    const newId = id === activeTemplateId ? "" : id;
    setActiveTemplateId(newId);
    await invoke("set_setting", { key: "active_template_id", value: newId }).catch(() => {});
  }

  function startNew() {
    setEditingTemplate({ id: "", name: "", instructions: "", created_at: "" });
    setEditName("");
    setEditInstructions("");
  }

  function startEdit(t: WritingTemplate) {
    setEditingTemplate(t);
    setEditName(t.name);
    setEditInstructions(t.instructions);
  }

  function cancelEdit() {
    setEditingTemplate(null);
  }

  async function handleSaveTemplate() {
    if (!editName.trim()) return;
    setTemplateSaving(true);
    try {
      const saved = await invoke<WritingTemplate>("save_writing_template", {
        id: editingTemplate?.id || null,
        name: editName.trim(),
        instructions: editInstructions,
      });
      setTemplates(prev => {
        const exists = prev.find(t => t.id === saved.id);
        return exists ? prev.map(t => t.id === saved.id ? saved : t) : [...prev, saved];
      });
      setEditingTemplate(null);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setTemplateSaving(false);
    }
  }

  async function handleDeleteTemplate(id: string) {
    await invoke("delete_writing_template", { id }).catch(() => {});
    setTemplates(prev => prev.filter(t => t.id !== id));
    if (activeTemplateId === id) {
      setActiveTemplateId("");
      invoke("set_setting", { key: "active_template_id", value: "" }).catch(() => {});
    }
  }

  return (
    <div className="settings-page page-enter">
      <div className="settings-content">

        <div className="settings-hero">
          <h1 className="settings-title">Settings</h1>
          <p className="settings-subtitle">Configure your Mail Reader preferences</p>
        </div>

        {/* Appearance */}
        <div className="settings-group">
          <h2 className="settings-group-label">Appearance</h2>
          <div className="settings-card">
            <div className="settings-item settings-item-stacked">
              <div className="settings-item-body">
                <span className="settings-item-label">Accent colour</span>
                <span className="settings-item-desc">Changes the highlight colour used throughout the app</span>
              </div>
              <div className="accent-swatches">
                {ACCENT_COLORS.map(c => (
                  <button
                    key={c.id}
                    className={`accent-swatch ${accent === c.id ? "accent-swatch-active" : ""}`}
                    title={c.label}
                    onClick={() => onAccentChange(c.id)}
                    style={{ "--swatch-color": c.dark } as React.CSSProperties}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Email Sync */}
        <div className="settings-group">
          <h2 className="settings-group-label">Email Sync</h2>
          <div className="settings-card">
            <div className="settings-item">
              <div className="settings-item-icon"><CalendarIcon /></div>
              <div className="settings-item-body">
                <span className="settings-item-label">Lookback period</span>
                <span className="settings-item-desc">Days of email history to sync (1–90)</span>
              </div>
              <div className="settings-item-control">
                <input
                  type="number"
                  className="settings-input"
                  value={lookback}
                  min={1}
                  max={90}
                  onChange={e => setLookback(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* AI Model */}
        <div className="settings-group">
          <h2 className="settings-group-label">AI Model</h2>
          <div className="settings-card">
            <div className="settings-item">
              <div className="settings-item-icon"><BotIcon /></div>
              <div className="settings-item-body">
                <span className="settings-item-label">Ollama model</span>
                <span className="settings-item-desc">
                  {modelStatus === "error"
                    ? "⚠ Ollama is not running — start it to load models"
                    : "Model used for email analysis and chat"}
                </span>
              </div>
              <div className="settings-item-control">
                <ModelPicker
                  models={models}
                  value={ollamaModel}
                  onChange={setOllamaModel}
                  status={modelStatus}
                  onRetry={() => loadModels()}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Writing styles */}
        <div className="settings-group">
          <h2 className="settings-group-label">Writing Styles</h2>
          <p className="settings-group-desc">
            Create tone and style presets. The active one is injected into every email analysis and draft — your core instructions stay intact, this just adds your personal style on top.
          </p>

          {templates.length > 0 && (
            <div className="wt-default-row">
              <span className="wt-default-label">Default style</span>
              <StylePicker
                styles={templates}
                value={activeTemplateId}
                onChange={handleSetActive}
              />
            </div>
          )}

          <div className="wt-list">
            {templates.map(t => (
              <div key={t.id} className={`wt-card ${activeTemplateId === t.id ? "wt-card-active" : ""}`}>
                <div className="wt-card-header">
                  <span className="wt-name">{t.name}</span>
                  {activeTemplateId === t.id && <span className="wt-active-badge">Active</span>}
                  <div className="wt-card-actions">
                    <button className="wt-action-btn" onClick={() => startEdit(t)} title="Edit"><PencilIcon /></button>
                    <button className="wt-action-btn wt-delete-btn" onClick={() => handleDeleteTemplate(t.id)} title="Delete">×</button>
                  </div>
                </div>
                {t.instructions && (
                  <p className="wt-preview">{t.instructions.slice(0, 120)}{t.instructions.length > 120 ? "…" : ""}</p>
                )}
              </div>
            ))}

            {templates.length === 0 && !editingTemplate && (
              <p className="wt-empty">No writing styles yet. Create one to customise tone and formatting.</p>
            )}
          </div>

          {/* Inline editor */}
          {editingTemplate !== null ? (
            <div className="wt-editor">
              <input
                ref={nameInputRef}
                className="wt-editor-name"
                placeholder="Style name (e.g. Concise & friendly)"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleSaveTemplate(); if (e.key === "Escape") cancelEdit(); }}
              />
              <textarea
                className="wt-editor-instructions"
                placeholder={"Describe your writing style, tone, and any specific instructions.\nExamples:\n• Keep replies brief — 3 sentences max\n• Always sign off with \"Best,\"\n• Formal tone, avoid contractions"}
                value={editInstructions}
                onChange={e => setEditInstructions(e.target.value)}
                rows={6}
              />
              <div className="wt-editor-actions">
                <button className="btn btn-sm" onClick={cancelEdit} disabled={templateSaving}>Cancel</button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleSaveTemplate}
                  disabled={!editName.trim() || templateSaving}
                >
                  {templateSaving ? "Saving…" : "Save style"}
                </button>
              </div>
            </div>
          ) : (
            <button className="wt-add-btn" onClick={startNew}>+ New writing style</button>
          )}
        </div>

        {/* Developer */}
        <div className="settings-group">
          <h2 className="settings-group-label">Developer</h2>
          <div className="settings-card">
            <div className="settings-item">
              <div className="settings-item-icon"><TerminalIcon /></div>
              <div className="settings-item-body">
                <span className="settings-item-label">
                  Debug mode
                  {savedDebugMode && <span className="settings-debug-active-dot" title="Debug mode is active" />}
                </span>
                <span className="settings-item-desc">
                  Show raw model output after each analysis attempt — helps diagnose JSON parse errors and retries.
                </span>
              </div>
              <div className="settings-item-control">
                <Toggle checked={debugMode} onChange={setDebugMode} />
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* Unsaved changes bar */}
      {showBar && (
        <div className={`settings-save-bar ${saveStatus === "saved" ? "settings-save-bar-saved" : ""}`}>
          <span className="settings-save-bar-msg">
            {saveStatus === "saved" ? "✓ Settings saved" : saveStatus === "saving" ? "Saving…" : "You have unsaved changes"}
          </span>
          {saveStatus !== "saved" && (
            <div className="settings-save-bar-actions">
              <button className="btn btn-sm" onClick={handleDiscard} disabled={saveStatus === "saving"}>Discard</button>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleSaveAll}
                disabled={saveStatus === "saving" || !isDirty}
              >
                {saveStatus === "saving" ? "Saving…" : "Save changes"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
