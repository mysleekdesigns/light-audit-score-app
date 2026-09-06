/**
 * The Authentication disclosure's draft shape, validation and readout helpers
 * (ROADMAP Phase B).
 *
 * The wire contract is `AuditCredentials` — three optional fields, each either
 * present and meaningful or absent (see `@/lib/lighthouse/credentials`). A form
 * cannot hold that shape directly: a user builds a header map by typing into a
 * growing list of name/value rows, half of which are blank at any moment. This
 * module owns the translation between the two, and it is deliberately the ONLY
 * place that translation happens, so the rules are stated once and tested once.
 *
 * ## Why the rules are duplicated here at all
 *
 * `auditOptionsSchema` (`@/lib/lighthouse/options`) is the validation authority
 * — the server rejects a malformed credential whatever the client does, and it
 * must, because the client is not a trust boundary. But a 400 arriving after you
 * press "Run audit" is a terrible way to learn that a header name may not
 * contain a colon. So the same grammars (imported from `credentials.ts`, never
 * re-typed) are applied here to produce the *same messages* next to the field
 * that caused them. If the two ever disagree the server still wins; the cost of
 * drift is a confusing message, not an unsafe request.
 *
 * ## What is deliberately NOT here
 *
 * No persistence of any kind. The draft this module describes lives in a plain
 * `useState` in `NewAuditForm` and dies with the page — it is never written to
 * `localStorage` (`useAuditDefaults`), `sessionStorage` (`useLocalAuditDraft`),
 * SQLite, or a report. These are the audited site's secrets, not ours.
 *
 * Pure and free of React/DOM imports so it unit-tests in the repo's `node`
 * vitest environment.
 */

import {
  COOKIE_NAME_PATTERN,
  COOKIE_VALUE_FORBIDDEN,
  HEADER_NAME_PATTERN,
  HEADER_VALUE_FORBIDDEN,
  MAX_CREDENTIAL_ENTRIES,
  MAX_HEADER_NAME_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  type AuditCredentials,
} from "@/lib/lighthouse/credentials";

// --- Draft shape -----------------------------------------------------------

/** Which grammar a row is validated against — they differ only in the value. */
export type CredentialRowKind = "header" | "cookie";

/**
 * One name/value row of the header or cookie list.
 *
 * `id` exists purely as a stable React key. Rows are added and removed from the
 * middle of the list, so keying by array index would let React reuse one row's
 * DOM node (and its caret, and its `type="password"` state) for a different
 * row's data after a removal. It is never sent, never rendered, and never
 * validated.
 */
export interface CredentialRow {
  id: string;
  name: string;
  value: string;
}

/**
 * Everything the Authentication disclosure holds. Two lists plus the basic-auth
 * pair — the same three mechanisms `AuditCredentials` carries, in the shape a
 * form can actually edit.
 */
export interface CredentialDraft {
  basicAuth: { username: string; password: string };
  cookies: CredentialRow[];
  headers: CredentialRow[];
}

/** A blank row with the given key. */
export function emptyCredentialRow(id: string): CredentialRow {
  return { id, name: "", value: "" };
}

/**
 * A pristine draft: no basic auth, and ONE blank row in each list.
 *
 * The lists start with a row rather than empty so the panel opens as a form
 * rather than as two "Add" buttons over nothing. A wholly blank row is dropped
 * by {@link resolveCredentialDraft}, so this initial state resolves to no
 * credentials at all — opening the disclosure and closing it again cannot
 * change what gets sent.
 */
export function emptyCredentialDraft(): CredentialDraft {
  return {
    basicAuth: { username: "", password: "" },
    cookies: [emptyCredentialRow("cookie-0")],
    headers: [emptyCredentialRow("header-0")],
  };
}

// --- Validation results ----------------------------------------------------

/**
 * One row's failure, scoped to the input that caused it.
 *
 * `field` is what lets the panel put `aria-invalid` on the offending half of the
 * row rather than on both — marking the name invalid because the value contains
 * a semicolon would send a screen-reader user to the wrong input.
 */
export interface CredentialRowError {
  field: "name" | "value";
  message: string;
}

/**
 * Per-field validation messages, keyed so each one can be rendered against the
 * control that produced it (`aria-describedby` → `FieldError`). Row messages are
 * keyed by {@link CredentialRow.id}; an id absent from the map is a valid row.
 */
export interface CredentialDraftErrors {
  /** Message for the basic-auth username input, or null when it is fine. */
  username: string | null;
  /** Message for the basic-auth password input, or null when it is fine. */
  password: string | null;
  /** Row id → failure, for cookie rows that failed. */
  cookies: Record<string, CredentialRowError>;
  /** Row id → failure, for header rows that failed. */
  headers: Record<string, CredentialRowError>;
  /** Messages that belong to the panel rather than to any one field (entry caps). */
  panel: string[];
}

/** The full result of interpreting a draft: what to send, and what to say. */
export interface CredentialResolution {
  /**
   * The credential block to send, or `undefined` when the draft carries none.
   *
   * `undefined` — an ABSENT field, not an empty object — is the only honest
   * representation of "no credential": it is what an unauthenticated audit has
   * always sent, so an untouched Authentication panel leaves the request byte
   * for byte what it was before this feature existed.
   *
   * Populated even when {@link CredentialResolution.errors} is non-empty (the
   * valid entries are still there); callers gate on {@link hasErrors}, not on
   * this being present.
   */
  credentials?: AuditCredentials;
  errors: CredentialDraftErrors;
  /** True when anything in {@link errors} is populated. */
  hasErrors: boolean;
  /**
   * The first problem, as one sentence, for the submit gate's caption — the
   * user needs to know *why* Run audit is disabled without opening the panel.
   */
  firstError: string | null;
  /**
   * Non-blocking notes about a request that is valid but probably not what the
   * user meant — currently only the `Authorization`/`Cookie` precedence rule
   * (an explicit header row of that name overrides the sugar above it, see
   * `buildCredentialHeaders`).
   */
  warnings: string[];
}

// --- Row → record ----------------------------------------------------------

/** Grammar + messages for one row kind, so the two lists share one code path. */
interface RowGrammar {
  namePattern: RegExp;
  valueForbidden: RegExp;
  /** Sentence-case noun used in messages, e.g. "Header name may only…". */
  label: "Header" | "Cookie";
  valueMessage: string;
  /**
   * Whether two names differing only in case collide. HTTP field names are
   * case-insensitive (RFC 7230 §3.2), so `X-Token` and `x-token` are one header
   * the user has typed twice; cookie names are case-sensitive (RFC 6265 §4.1.1),
   * so `id` and `ID` are genuinely two cookies.
   */
  caseInsensitiveNames: boolean;
}

const ROW_GRAMMARS: Record<CredentialRowKind, RowGrammar> = {
  header: {
    namePattern: HEADER_NAME_PATTERN,
    valueForbidden: HEADER_VALUE_FORBIDDEN,
    label: "Header",
    valueMessage: "Header value must not contain line breaks or null bytes.",
    caseInsensitiveNames: true,
  },
  cookie: {
    namePattern: COOKIE_NAME_PATTERN,
    valueForbidden: COOKIE_VALUE_FORBIDDEN,
    label: "Cookie",
    valueMessage:
      "Cookie value must not contain ';', line breaks or null bytes.",
    caseInsensitiveNames: false,
  },
};

/**
 * Whitespace-trim both halves of a row before anything else looks at them.
 *
 * The server deliberately does NOT trim (`options.ts`) — on the wire, `" X-Token"`
 * is a different header than `"X-Token"` and silently rewriting it would be
 * dishonest. In a form the calculus is the opposite: an `<input>` is single-line,
 * so no interior whitespace is at risk, and the leading/trailing kind is
 * essentially always an artefact of pasting a token out of DevTools. Trimming it
 * here turns the overwhelmingly common paste into a working audit instead of a
 * validation error about a space the user cannot see.
 *
 * The basic-auth pair is pointedly exempt: a password's surrounding whitespace
 * is significant, and it cannot contain CR/LF/NUL anyway.
 */
function trimRow(row: CredentialRow): { name: string; value: string } {
  return { name: row.name.trim(), value: row.value.trim() };
}

/** True when the user has typed nothing at all into a row. */
function isBlankRow(row: CredentialRow): boolean {
  const { name, value } = trimRow(row);
  return name.length === 0 && value.length === 0;
}

/**
 * Validate one list of rows, returning the record to send plus a message per
 * failing row id. Wholly blank rows are skipped in silence — they are the empty
 * form, not an error — and an all-blank list yields `undefined` rather than
 * `{}`, matching the schema's own "empty map normalises to absent" transform.
 *
 * On a duplicate name the LAST row wins, which is what building a record from a
 * list does anyway; the duplicate is flagged so the user resolves it rather than
 * silently losing the row they typed first.
 */
function resolveRows(
  rows: CredentialRow[],
  kind: CredentialRowKind,
): {
  record?: Record<string, string>;
  errors: Record<string, CredentialRowError>;
} {
  const grammar = ROW_GRAMMARS[kind];
  const errors: Record<string, CredentialRowError> = {};
  const record: Record<string, string> = {};
  /** Normalised name → the id of the first row that claimed it. */
  const seen = new Map<string, string>();

  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const { name, value } = trimRow(row);

    if (name.length === 0) {
      errors[row.id] = {
        field: "name",
        message: `Add a name for this ${grammar.label.toLowerCase()}.`,
      };
      continue;
    }
    if (name.length > MAX_HEADER_NAME_LENGTH) {
      errors[row.id] = {
        field: "name",
        message: `${grammar.label} name must be at most ${MAX_HEADER_NAME_LENGTH} characters.`,
      };
      continue;
    }
    if (!grammar.namePattern.test(name)) {
      errors[row.id] = {
        field: "name",
        message: `${grammar.label} name may only contain letters, digits and !#$%&'*+-.^_\`|~`,
      };
      continue;
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      errors[row.id] = {
        field: "value",
        message: `Value must be at most ${MAX_HEADER_VALUE_LENGTH} characters.`,
      };
      continue;
    }
    if (grammar.valueForbidden.test(value)) {
      errors[row.id] = { field: "value", message: grammar.valueMessage };
      continue;
    }

    const key = grammar.caseInsensitiveNames ? name.toLowerCase() : name;
    const firstId = seen.get(key);
    if (firstId !== undefined) {
      const duplicate: CredentialRowError = {
        field: "name",
        message: `Duplicate ${grammar.label.toLowerCase()} name — remove one row.`,
      };
      errors[firstId] = duplicate;
      errors[row.id] = duplicate;
    }
    seen.set(key, row.id);
    record[name] = value;
  }

  return {
    record: Object.keys(record).length > 0 ? record : undefined,
    errors,
  };
}

// --- The one entry point ---------------------------------------------------

/**
 * Interpret a draft: what to send, what to complain about, what to warn about.
 *
 * Total and pure — it never throws and never mutates its input, so the form can
 * call it on every keystroke inside a `useMemo` and use one result for the
 * submit gate, the crawl request, the per-field errors and the readout.
 */
export function resolveCredentialDraft(
  draft: CredentialDraft,
): CredentialResolution {
  const errors: CredentialDraftErrors = {
    username: null,
    password: null,
    cookies: {},
    headers: {},
    panel: [],
  };
  const warnings: string[] = [];
  const credentials: AuditCredentials = {};

  // --- Basic auth. Untrimmed on purpose (see `trimRow`). An empty username is
  // rejected by the schema, so a lone password is an error rather than a
  // half-applied credential; a wholly empty pair is simply absent.
  const { username, password } = draft.basicAuth;
  if (username.length > 0 || password.length > 0) {
    if (username.length === 0) {
      errors.username = "Basic-auth username must not be empty.";
    } else if (HEADER_VALUE_FORBIDDEN.test(username)) {
      errors.username =
        "Basic-auth username must not contain line breaks or null bytes.";
    } else if (username.length > MAX_HEADER_VALUE_LENGTH) {
      errors.username = `Value must be at most ${MAX_HEADER_VALUE_LENGTH} characters.`;
    }
    if (HEADER_VALUE_FORBIDDEN.test(password)) {
      errors.password =
        "Basic-auth password must not contain line breaks or null bytes.";
    } else if (password.length > MAX_HEADER_VALUE_LENGTH) {
      errors.password = `Value must be at most ${MAX_HEADER_VALUE_LENGTH} characters.`;
    }
    if (errors.username === null && errors.password === null) {
      credentials.basicAuth = { username, password };
    }
  }

  const cookies = resolveRows(draft.cookies, "cookie");
  errors.cookies = cookies.errors;
  if (cookies.record) credentials.cookies = cookies.record;

  const headers = resolveRows(draft.headers, "header");
  errors.headers = headers.errors;
  if (headers.record) credentials.extraHeaders = headers.record;

  // Entry caps, mirroring the schema's per-map limit. Panel-level because no
  // single row is at fault — the list as a whole is too long.
  if (cookies.record && Object.keys(cookies.record).length > MAX_CREDENTIAL_ENTRIES) {
    errors.panel.push(`Provide at most ${MAX_CREDENTIAL_ENTRIES} cookies.`);
  }
  if (headers.record && Object.keys(headers.record).length > MAX_CREDENTIAL_ENTRIES) {
    errors.panel.push(`Provide at most ${MAX_CREDENTIAL_ENTRIES} extra headers.`);
  }

  // Precedence, not a mistake: `buildCredentialHeaders` writes the basic-auth
  // and cookie sugar first and lets an explicit header of the same name win, so
  // the escape hatch always beats the shorthand. Say so rather than letting the
  // shorthand look ignored.
  const headerNames = Object.keys(headers.record ?? {}).map((n) =>
    n.toLowerCase(),
  );
  if (credentials.basicAuth && headerNames.includes("authorization")) {
    warnings.push(
      "An explicit Authorization header overrides the basic-auth pair.",
    );
  }
  if (credentials.cookies && headerNames.includes("cookie")) {
    warnings.push("An explicit Cookie header overrides the cookie rows.");
  }

  const rowErrors = [
    ...Object.values(errors.cookies),
    ...Object.values(errors.headers),
  ];
  const firstError =
    errors.username ??
    errors.password ??
    rowErrors[0]?.message ??
    errors.panel[0] ??
    null;

  return {
    credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
    errors,
    hasErrors: firstError !== null,
    firstError,
    warnings,
  };
}

// --- Readout helpers (names only, never values) ----------------------------

/**
 * Name the mechanisms a credential block uses, in the order the engine applies
 * them (basic auth → cookies → explicit headers).
 *
 * Reads NAMES only, so it produces identical output for a live draft and for a
 * persisted `batch.options` whose values are already the literal `[redacted]`
 * marker — which is exactly what makes it safe to render in both places. There
 * is no code path here that can reach a value.
 */
export function describeCredentialMechanisms(
  credentials: AuditCredentials | undefined | null,
): string[] {
  if (!credentials) return [];
  const parts: string[] = [];
  if (credentials.basicAuth) parts.push("basic auth");
  for (const name of Object.keys(credentials.cookies ?? {})) {
    parts.push(`Cookie: ${name}`);
  }
  parts.push(...Object.keys(credentials.extraHeaders ?? {}));
  return parts;
}

/**
 * A compact monospace summary for the run-config readout cell — `"None"`,
 * `"Basic"`, `"Basic +2"` or `"3 keys"`. Counts mechanisms; like
 * {@link describeCredentialMechanisms} it never touches a value.
 */
export function summarizeCredentials(
  credentials: AuditCredentials | undefined | null,
): string {
  const total = describeCredentialMechanisms(credentials).length;
  if (total === 0) return "None";
  if (!credentials?.basicAuth) return `${total} ${total === 1 ? "key" : "keys"}`;
  return total === 1 ? "Basic" : `Basic +${total - 1}`;
}
