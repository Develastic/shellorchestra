// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type CronUserDTO = { name?: string; uid?: string; home?: string; shell?: string };
export type CronValidationIssueDTO = { line?: number; message?: string; text?: string };
export type CronPayloadDTO = {
  mode?: string;
  available?: boolean;
  message?: string;
  current_user?: string;
  users?: CronUserDTO[];
  user?: string;
  exists?: boolean;
  content?: string;
  saved?: boolean;
  valid?: boolean;
  entries?: number;
  errors?: CronValidationIssueDTO[];
  warnings?: CronValidationIssueDTO[];
};

export class CronUser {
  readonly name: string;
  readonly uid: string;
  readonly home: string;
  readonly shell: string;

  constructor(dto: CronUserDTO) {
    this.name = typeof dto.name === 'string' ? dto.name.trim() : '';
    this.uid = typeof dto.uid === 'string' ? dto.uid.trim() : '';
    this.home = typeof dto.home === 'string' ? dto.home.trim() : '';
    this.shell = typeof dto.shell === 'string' ? dto.shell.trim() : '';
  }

  label(): string {
    const details = [this.uid ? `uid ${this.uid}` : '', this.shell].filter(Boolean).join(' · ');
    return details ? `${this.name} (${details})` : this.name;
  }
}

export class CronUserCollection {
  readonly items: CronUser[];
  constructor(items: CronUser[]) { this.items = dedupeUsers(items); }
  static fromUnknown(value: unknown): CronUserCollection {
    if (!Array.isArray(value)) return new CronUserCollection([]);
    return new CronUserCollection(value.map((item) => new CronUser(item as CronUserDTO)).filter((item) => item.name));
  }
  firstName(): string { return this.items[0]?.name ?? ''; }
  has(name: string): boolean { return this.items.some((item) => item.name === name); }
}

export class CronValidationIssue {
  readonly line: number;
  readonly message: string;
  readonly text: string;

  constructor(dto: CronValidationIssueDTO) {
    this.line = typeof dto.line === 'number' && Number.isFinite(dto.line) ? Math.max(0, Math.trunc(dto.line)) : 0;
    this.message = typeof dto.message === 'string' ? dto.message : '';
    this.text = typeof dto.text === 'string' ? dto.text : '';
  }
}

export class CronEditorPayload {
  readonly mode: string;
  readonly available: boolean;
  readonly message: string;
  readonly currentUser: string;
  readonly users: CronUserCollection;
  readonly user: string;
  readonly exists: boolean;
  readonly content: string;
  readonly saved: boolean;
  readonly valid: boolean;
  readonly entries: number;
  readonly errors: CronValidationIssue[];
  readonly warnings: CronValidationIssue[];

  constructor(dto: CronPayloadDTO) {
    this.mode = typeof dto.mode === 'string' ? dto.mode : '';
    this.available = dto.available !== false;
    this.message = typeof dto.message === 'string' ? dto.message : '';
    this.currentUser = typeof dto.current_user === 'string' ? dto.current_user : '';
    this.users = CronUserCollection.fromUnknown(dto.users);
    this.user = typeof dto.user === 'string' ? dto.user : '';
    this.exists = Boolean(dto.exists);
    this.content = typeof dto.content === 'string' ? dto.content : '';
    this.saved = Boolean(dto.saved);
    this.valid = dto.valid !== false;
    this.entries = typeof dto.entries === 'number' && Number.isFinite(dto.entries) ? Math.max(0, Math.trunc(dto.entries)) : 0;
    this.errors = Array.isArray(dto.errors) ? dto.errors.map((item) => new CronValidationIssue(item)).filter((item) => item.message) : [];
    this.warnings = Array.isArray(dto.warnings) ? dto.warnings.map((item) => new CronValidationIssue(item)).filter((item) => item.message) : [];
  }

  static fromUnknown(value: unknown): CronEditorPayload {
    if (!value || typeof value !== 'object') return new CronEditorPayload({ available: false, message: 'Cron Editor did not receive a valid response from the server.' });
    return new CronEditorPayload(value as CronPayloadDTO);
  }
}

export class CronEditorSaveDraft {
  readonly user: string;
  readonly content: string;
  constructor(user: string, content: string) { this.user = user.trim(); this.content = content; }
  validate(): string | null {
    if (!safeUserName(this.user)) return 'Choose a valid user before saving crontab.';
    if (new TextEncoder().encode(this.content).byteLength > 256 * 1024) return 'This crontab is too large for the interactive editor.';
    return null;
  }
  toArgs(): Record<string, string> { return { cron_mode: 'save', cron_user: this.user, cron_content: this.content }; }
  toValidationArgs(): Record<string, string> { return { cron_mode: 'validate', cron_user: this.user, cron_content: this.content }; }
}

export function safeUserName(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value) && !value.endsWith('.') && !value.endsWith('-');
}

function dedupeUsers(users: CronUser[]): CronUser[] {
  const seen = new Set<string>();
  const result: CronUser[] = [];
  for (const user of users) {
    if (!user.name || seen.has(user.name)) continue;
    seen.add(user.name);
    result.push(user);
  }
  return result;
}
