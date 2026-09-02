/**
 * Ambient types for the Electron preload bridge (`electron/preload.js`).
 *
 * `window.lightaudit` exists ONLY inside the packaged desktop app; under
 * `next dev` / `next start` it is `undefined`, which is how the UI detects its
 * runtime. Secret values are encrypted/decrypted exclusively in the Electron main
 * process (safeStorage / OS keychain) — this bridge can submit a candidate key
 * and read a masked status, but can never read a stored raw key.
 */

/**
 * Keys the bridge can manage. The Electron main process resolves this name
 * against its own allow-list (`SECRET_SPECS`), so an unlisted name is rejected
 * rather than reaching the keychain.
 */
type LightAuditSecretName = "PAGESPEED_API_KEY";

interface LightAuditSecretStatus {
  /** Whether OS secure storage (keychain) is usable on this machine. */
  available: boolean;
  /** Whether a key is currently stored under the requested name. */
  set: boolean;
  /** Masked display hint (e.g. "••••aB12") — never the full key. */
  hint?: string;
  /**
   * The main process refused the call (untrusted sender, or a name outside the
   * allow-list) rather than reporting on real keychain state. Lets the UI avoid
   * claiming "secure storage is unavailable" when that isn't what happened.
   */
  rejected?: boolean;
}

interface LightAuditSecretResult {
  ok: boolean;
  error?: string;
  /** Optional informational note (e.g. a test that timed out but was authorised). */
  note?: string;
}

interface LightAuditBridge {
  secrets: {
    status(name: LightAuditSecretName): Promise<LightAuditSecretStatus>;
    set(name: LightAuditSecretName, value: string): Promise<LightAuditSecretResult>;
    test(name: LightAuditSecretName, value: string): Promise<LightAuditSecretResult>;
    clear(name: LightAuditSecretName): Promise<LightAuditSecretResult>;
  };
}

interface Window {
  lightaudit?: LightAuditBridge;
}
