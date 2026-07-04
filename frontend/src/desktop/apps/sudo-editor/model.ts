// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type SudoersFileDTO = { path?: string; size?: string | number; mode?: string };
export type SudoEditorPayloadDTO = {
  mode?: string;
  available?: boolean;
  message?: string;
  files?: SudoersFileDTO[];
  path?: string;
  content?: string;
  size?: string | number;
  saved?: boolean;
  valid?: boolean;
  validation_output?: string;
};

export class SudoersFile {
  readonly path: string;
  readonly size: string;
  readonly mode: string;
  constructor(dto: SudoersFileDTO) {
    this.path = text(dto.path);
    this.size = dto.size === undefined || dto.size === null ? '' : String(dto.size).trim();
    this.mode = text(dto.mode);
  }
  label(): string { return this.path.replace('/etc/', ''); }
}

export class SudoersFileCollection {
  readonly items: SudoersFile[];
  constructor(items: SudoersFile[]) { this.items = dedupe(items); }
  static fromUnknown(value: unknown): SudoersFileCollection {
    if (!Array.isArray(value)) return new SudoersFileCollection([]);
    return new SudoersFileCollection(value.map((item) => new SudoersFile(item as SudoersFileDTO)).filter((item) => safeSudoersPath(item.path)));
  }
  firstPath(): string { return this.items[0]?.path ?? ''; }
  has(path: string): boolean { return this.items.some((item) => item.path === path); }
}

export class SudoEditorPayload {
  readonly mode: string;
  readonly available: boolean;
  readonly message: string;
  readonly files: SudoersFileCollection;
  readonly path: string;
  readonly content: string;
  readonly size: string;
  readonly saved: boolean;
  readonly valid: boolean;
  readonly validationOutput: string;
  constructor(dto: SudoEditorPayloadDTO) {
    this.mode = text(dto.mode);
    this.available = dto.available !== false;
    this.message = text(dto.message);
    this.files = SudoersFileCollection.fromUnknown(dto.files);
    this.path = text(dto.path);
    this.content = typeof dto.content === 'string' ? dto.content : '';
    this.size = dto.size === undefined || dto.size === null ? '' : String(dto.size).trim();
    this.saved = Boolean(dto.saved);
    this.valid = dto.valid === true;
    this.validationOutput = typeof dto.validation_output === 'string' ? dto.validation_output : '';
  }
  static fromUnknown(value: unknown): SudoEditorPayload {
    if (!value || typeof value !== 'object') return new SudoEditorPayload({ available: false, message: 'Edit Sudo did not receive a valid response from the server.' });
    return new SudoEditorPayload(value as SudoEditorPayloadDTO);
  }
}

export class SudoEditorSaveDraft {
  readonly path: string;
  readonly content: string;
  constructor(path: string, content: string) { this.path = path.trim(); this.content = content; }
  validate(): string | null {
    if (!safeSudoersPath(this.path)) return 'Choose /etc/sudoers or a safe file inside /etc/sudoers.d before saving.';
    if (new TextEncoder().encode(this.content).byteLength > 256 * 1024) return 'This sudoers file is too large for the interactive editor.';
    return null;
  }
  toArgs(): Record<string, string> { return { sudo_mode: 'save', sudo_path: this.path, sudo_content: this.content }; }
}

export function safeSudoersPath(value: string): boolean {
  if (value === '/etc/sudoers') return true;
  if (!value.startsWith('/etc/sudoers.d/')) return false;
  const name = value.slice('/etc/sudoers.d/'.length);
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) && !name.includes('/');
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function dedupe(files: SudoersFile[]): SudoersFile[] {
  const seen = new Set<string>();
  const out: SudoersFile[] = [];
  for (const file of files) {
    if (!file.path || seen.has(file.path)) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}
