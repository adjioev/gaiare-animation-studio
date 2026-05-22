import { invoke } from "@tauri-apps/api/core";

/** API keys the Rust process needs, stored per-user in the OS keychain. The
 *  value never round-trips back to JS — only the entry (set) and a set/not-set
 *  status come back. */
export type SecretKey = "replicate" | "gemini" | "fireworks";

export const SECRET_FIELDS: {
  key: SecretKey;
  label: string;
  placeholder: string;
  hint: string;
}[] = [
  { key: "replicate", label: "Replicate API token", placeholder: "r8_…", hint: "replicate.com → Account → API tokens" },
  { key: "gemini", label: "Google AI (Gemini) key", placeholder: "AIza…", hint: "aistudio.google.com → Get API key" },
  { key: "fireworks", label: "Fireworks AI key", placeholder: "fw_…", hint: "fireworks.ai → API keys" },
];

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  await invoke("set_secret", { key, value });
}

export async function clearSecret(key: SecretKey): Promise<void> {
  await invoke("clear_secret", { key });
}

/** Returns only whether the key is set — never the value. */
export async function secretStatus(key: SecretKey): Promise<boolean> {
  return invoke<boolean>("secret_status", { key });
}
