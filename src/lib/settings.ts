// App-level settings — currently just the workspace folder name, but
// the schema is set up so we can grow it (Replicate model selection,
// default narration voice, contractor identity, etc.) without
// migrating callers. Persisted to localStorage so it survives app
// restarts without touching the workspace dir (which depends on the
// setting itself — chicken-and-egg if we stored it on disk under the
// workspace dir).

const STORAGE_KEY = "gaiare-animation-studio.settings.v1";

export const DEFAULT_FOLDER_NAME = "gaiare-animation-studio";

export type Settings = {
  /** Subfolder under the user's Documents directory where all
   *  workspaces live. Cross-platform — Tauri's `documentDir()`
   *  resolves to ~/Documents on macOS/Linux and the
   *  user-configured Documents path on Windows (which may be
   *  redirected to OneDrive). Constrained to a folder name (no path
   *  separators) for Windows compatibility and to keep the scope
   *  tight. */
  workspaceFolderName: string;
  /** Human-readable identity displayed on workspace locks. Doesn't
   *  authenticate — purely advisory ("Anna is editing q14") so two
   *  contractors don't clobber each other in a small team. */
  contractorId?: string;
  /** Hide the AI prompt author side panel. Defaults to false (panel
   *  shown). Persisted across launches so the user's last preference
   *  sticks. */
  chatPanelCollapsed?: boolean;
  /** Pixel width of the AI prompt author side panel when expanded.
   *  Defaults to 384 (the original `w-96`). Persisted on resize so
   *  the contractor's preferred working width survives restarts. */
  chatPanelWidth?: number;
};

export const DEFAULT_SETTINGS: Settings = {
  workspaceFolderName: DEFAULT_FOLDER_NAME,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      workspaceFolderName: sanitizeFolderName(
        parsed.workspaceFolderName ?? DEFAULT_FOLDER_NAME,
      ),
      contractorId: parsed.contractorId?.trim() || undefined,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * Strip characters that break on Windows or get parsed weirdly by
 * Tauri's fs scope checker:
 *
 *   < > : " / \ | ? *  — reserved on Windows
 *   leading/trailing whitespace, leading dot — historical Windows quirks
 *   path separators on any OS
 *
 * Returns the cleaned name, or the default if the input becomes empty.
 */
export function sanitizeFolderName(input: string): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  return cleaned.length > 0 ? cleaned : DEFAULT_FOLDER_NAME;
}

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Returns an error message if the folder name is invalid, or null if
 * it's accepted. Surface in the settings UI before saving so the user
 * sees the problem instead of running into a silent fs error later.
 */
export function validateFolderName(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "Folder name can't be empty.";
  if (trimmed.length > 64) return "Folder name too long (max 64 chars).";
  if (/[<>:"/\\|?*\x00-\x1f]/.test(trimmed)) {
    return 'Folder name contains a reserved character ( < > : " / \\ | ? * ).';
  }
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) {
    return "Folder name can't start or end with a dot.";
  }
  if (WINDOWS_RESERVED.has(trimmed.toUpperCase())) {
    return `"${trimmed}" is a reserved name on Windows.`;
  }
  return null;
}
