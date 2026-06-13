/**
 * Ambient types for the Electron preload bridge (`electron/preload.js`).
 *
 * `window.lightaudit` exists ONLY inside the packaged desktop app; under
 * `next dev` / `next start` it is `undefined`, which is how the UI detects its
 * runtime. Secret values are encrypted/decrypted exclusively in the Electron main
 * process (safeStorage / OS keychain) — this bridge can submit a candidate key
 * and read a masked status, but can never read a stored raw key.
 */

interface LightAuditSecretStatus {
  /** Whether OS secure storage (keychain) is usable on this machine. */
  available: boolean;
  /** Whether a PageSpeed Insights key is currently stored. */
  set: boolean;
  /** Masked display hint (e.g. "••••aB12") — never the full key. */
  hint?: string;
}

interface LightAuditSecretResult {
  ok: boolean;
  error?: string;
  /** Optional informational note (e.g. a test that timed out but was authorised). */
  note?: string;
}

interface LightAuditBridge {
  secrets: {
    status(): Promise<LightAuditSecretStatus>;
    set(value: string): Promise<LightAuditSecretResult>;
    test(value: string): Promise<LightAuditSecretResult>;
    clear(): Promise<LightAuditSecretResult>;
  };
}

interface Window {
  lightaudit?: LightAuditBridge;
}
