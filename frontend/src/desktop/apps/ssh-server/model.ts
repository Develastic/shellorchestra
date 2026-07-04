// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type SSHServerDTO = {
  generated_at?: string;
  platform?: string;
  sshd?: SSHDStatusDTO;
  config_files?: string[];
  config_file_details?: SSHConfigFileDTO[];
  options?: SSHServerOptionDTO[];
  trusted_user_ca_keys?: SSHTrustedCADTO[];
  match_blocks?: SSHMatchBlockDTO[];
  effective_lines?: string[];
};

export type SSHDStatusDTO = {
  installed?: boolean;
  running?: boolean;
  service_name?: string;
  version?: string;
  config_path?: string;
  effective_available?: boolean;
  effective_error?: string;
};

export type SSHServerOptionDTO = {
  key?: string;
  value?: string;
  effective_value?: string;
  source?: string;
  line?: number;
  severity?: string;
  warning?: string;
  recommended?: string;
  category?: string;
  description?: string;
  known_values?: string[];
  configured?: boolean;
};

export type SSHConfigFileDTO = {
  path?: string;
  exists?: boolean;
  readable?: boolean;
  writable?: boolean;
  size_bytes?: number;
  sha256?: string;
  content_available?: boolean;
  content?: string;
};

export type SSHTrustedCADTO = {
  path?: string;
  source?: string;
  line?: number;
  exists?: boolean;
  readable?: boolean;
  fingerprints?: string[];
};

export type SSHMatchBlockDTO = {
  source?: string;
  start_line?: number;
  condition?: string;
  body?: string;
};

export type SSHServerSeverity = 'critical' | 'warning' | 'info' | '';

export class SSHDStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly serviceName: string;
  readonly version: string;
  readonly configPath: string;
  readonly effectiveAvailable: boolean;
  readonly effectiveError: string;

  constructor(dto: SSHDStatusDTO = {}) {
    this.installed = dto.installed === true;
    this.running = dto.running === true;
    this.serviceName = stringValue(dto.service_name);
    this.version = stringValue(dto.version);
    this.configPath = stringValue(dto.config_path);
    this.effectiveAvailable = dto.effective_available === true;
    this.effectiveError = stringValue(dto.effective_error);
  }

  get stateLabel(): string {
    if (!this.installed) return 'not installed';
    return this.running ? 'running' : 'not running';
  }
}

export class SSHServerOption {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly effectiveValue: string;
  readonly source: string;
  readonly line: number;
  readonly severity: SSHServerSeverity;
  readonly warning: string;
  readonly recommended: string;
  readonly category: string;
  readonly description: string;
  readonly knownValues: string[];
  readonly configured: boolean;

  constructor(dto: SSHServerOptionDTO, index: number) {
    this.key = stringValue(dto.key);
    this.value = stringValue(dto.value);
    this.effectiveValue = stringValue(dto.effective_value);
    this.source = stringValue(dto.source);
    this.line = numberValue(dto.line);
    this.severity = normalizeSeverity(dto.severity);
    this.warning = stringValue(dto.warning);
    this.recommended = stringValue(dto.recommended);
    this.category = stringValue(dto.category);
    this.description = stringValue(dto.description);
    this.knownValues = Array.isArray(dto.known_values) ? dto.known_values.map(stringValue).filter(Boolean) : [];
    this.configured = dto.configured !== false;
    this.id = `${this.source}:${this.line}:${this.key}:${index}`;
  }

  matches(query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${this.category} ${this.key} ${this.description} ${this.value} ${this.effectiveValue} ${this.source} ${this.warning}`.toLowerCase().includes(needle);
  }

  get locationLabel(): string {
    if (!this.configured) return 'not configured';
    if (!this.source) return this.line > 0 ? `line ${this.line}` : '—';
    return this.line > 0 ? `${this.source}:${this.line}` : this.source;
  }
}

export class SSHConfigFile {
  readonly path: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentAvailable: boolean;
  readonly content: string;

  constructor(dto: SSHConfigFileDTO) {
    this.path = stringValue(dto.path);
    this.exists = dto.exists === true;
    this.readable = dto.readable === true;
    this.writable = dto.writable === true;
    this.sizeBytes = numberValue(dto.size_bytes);
    this.sha256 = stringValue(dto.sha256);
    this.contentAvailable = dto.content_available === true;
    this.content = typeof dto.content === 'string' ? dto.content : '';
  }

  get editable(): boolean {
    return this.exists && this.readable && this.writable && this.contentAvailable && safeOpenSSHConfigPath(this.path) && Boolean(this.sha256);
  }

  get stateLabel(): string {
    if (!this.exists) return 'missing';
    if (!this.readable) return 'not readable';
    if (!this.contentAvailable) return 'too large for editor';
    if (!this.writable) return 'needs admin rights';
    return 'editable';
  }

  get displayName(): string {
    if (!this.path) return '—';
    return this.path.replace(/^\/(?:usr\/local\/)?etc\/ssh\//, '').replace(/^\/private\/etc\/ssh\//, '');
  }
}

export class SSHConfigFileCollection {
  readonly items: SSHConfigFile[];

  constructor(items: SSHConfigFile[]) {
    const seen = new Set<string>();
    this.items = items.filter((item) => {
      if (!item.path || seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  }

  static fromUnknown(value: unknown): SSHConfigFileCollection {
    if (!Array.isArray(value)) return new SSHConfigFileCollection([]);
    return new SSHConfigFileCollection(value.map((item) => new SSHConfigFile(item as SSHConfigFileDTO)));
  }

  firstEditablePath(): string {
    return this.items.find((item) => item.editable)?.path ?? this.items[0]?.path ?? '';
  }

  byPath(path: string): SSHConfigFile | undefined {
    return this.items.find((item) => item.path === path);
  }
}

export class SSHTrustedCA {
  readonly id: string;
  readonly path: string;
  readonly source: string;
  readonly line: number;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly fingerprints: string[];

  constructor(dto: SSHTrustedCADTO, index: number) {
    this.path = stringValue(dto.path);
    this.source = stringValue(dto.source);
    this.line = numberValue(dto.line);
    this.exists = dto.exists === true;
    this.readable = dto.readable === true;
    this.fingerprints = Array.isArray(dto.fingerprints) ? dto.fingerprints.map(stringValue).filter(Boolean) : [];
    this.id = `${this.source}:${this.line}:${this.path}:${index}`;
  }

  get stateLabel(): string {
    if (!this.exists) return 'missing';
    if (!this.readable) return 'not readable';
    return this.fingerprints.length > 0 ? 'readable' : 'empty or unknown';
  }

  get tone(): 'success' | 'warning' | 'error' | 'default' {
    if (!this.exists) return 'error';
    if (!this.readable || this.fingerprints.length === 0) return 'warning';
    return 'success';
  }
}

export class SSHMatchBlock {
  readonly id: string;
  readonly source: string;
  readonly startLine: number;
  readonly condition: string;
  readonly body: string;

  constructor(dto: SSHMatchBlockDTO, index: number) {
    this.source = stringValue(dto.source);
    this.startLine = numberValue(dto.start_line);
    this.condition = stringValue(dto.condition);
    this.body = stringValue(dto.body);
    this.id = `${this.source}:${this.startLine}:${index}`;
  }

  get locationLabel(): string {
    if (!this.source) return this.startLine > 0 ? `line ${this.startLine}` : '—';
    return this.startLine > 0 ? `${this.source}:${this.startLine}` : this.source;
  }
}

export class SSHServerPayload {
  readonly generatedAt: string;
  readonly platform: string;
  readonly sshd: SSHDStatus;
  readonly configFiles: string[];
  readonly configFileDetails: SSHConfigFileCollection;
  readonly options: SSHServerOption[];
  readonly trustedCAs: SSHTrustedCA[];
  readonly matchBlocks: SSHMatchBlock[];
  readonly effectiveLines: string[];

  constructor(dto: SSHServerDTO) {
    this.generatedAt = stringValue(dto.generated_at);
    this.platform = stringValue(dto.platform) || 'unknown';
    this.sshd = new SSHDStatus(dto.sshd);
    this.configFiles = Array.isArray(dto.config_files) ? dto.config_files.map(stringValue).filter(Boolean) : [];
    this.configFileDetails = SSHConfigFileCollection.fromUnknown(dto.config_file_details);
    this.options = Array.isArray(dto.options) ? dto.options.map((item, index) => new SSHServerOption(item, index)).filter((item) => item.key) : [];
    this.trustedCAs = Array.isArray(dto.trusted_user_ca_keys) ? dto.trusted_user_ca_keys.map((item, index) => new SSHTrustedCA(item, index)).filter((item) => item.path) : [];
    this.matchBlocks = Array.isArray(dto.match_blocks) ? dto.match_blocks.map((item, index) => new SSHMatchBlock(item, index)).filter((item) => item.condition || item.body) : [];
    this.effectiveLines = Array.isArray(dto.effective_lines) ? dto.effective_lines.map(stringValue).filter(Boolean) : [];
  }

  static fromUnknown(value: unknown): SSHServerPayload {
    if (!value || typeof value !== 'object') return new SSHServerPayload({});
    return new SSHServerPayload(value as SSHServerDTO);
  }

  filterOptions(query: string): SSHServerOption[] {
    return this.options.filter((item) => item.matches(query));
  }

  countSeverity(severity: SSHServerSeverity): number {
    return this.options.filter((item) => item.severity === severity).length;
  }

  updatedLabel(): string {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleString();
  }

  mainConfigPath(): string {
    return this.sshd.configPath || this.configFiles[0] || this.configFileDetails.items[0]?.path || '';
  }
}

export type SSHServerActionResultDTO = {
  ok?: boolean;
  action?: string;
  path?: string;
  backup_path?: string;
  reloaded?: boolean;
  message?: string;
};

export class SSHServerActionResult {
  readonly ok: boolean;
  readonly action: string;
  readonly path: string;
  readonly backupPath: string;
  readonly reloaded: boolean;
  readonly message: string;

  constructor(dto: SSHServerActionResultDTO = {}) {
    this.ok = dto.ok === true;
    this.action = stringValue(dto.action);
    this.path = stringValue(dto.path);
    this.backupPath = stringValue(dto.backup_path);
    this.reloaded = dto.reloaded === true;
    this.message = stringValue(dto.message);
  }

  static fromUnknown(value: unknown): SSHServerActionResult {
    if (!value || typeof value !== 'object') return new SSHServerActionResult({});
    return new SSHServerActionResult(value as SSHServerActionResultDTO);
  }
}

export class SSHServerConfigDraft {
  readonly path: string;
  readonly content: string;
  readonly expectedHash: string;
  readonly mainConfig: string;

  constructor(path: string, content: string, expectedHash: string, mainConfig: string) {
    this.path = path.trim();
    this.content = content;
    this.expectedHash = expectedHash.trim();
    this.mainConfig = mainConfig.trim();
  }

  validate(): string | null {
    if (!safeOpenSSHConfigPath(this.path)) return 'Choose a supported OpenSSH server config file before saving.';
    if (!safeOpenSSHConfigPath(this.mainConfig)) return 'ShellOrchestra could not determine a supported OpenSSH main config file for validation.';
    if (!/^sha256:[a-f0-9]{64}$/i.test(this.expectedHash)) return 'Refresh SSH Server before applying this draft; the loaded file hash is missing.';
    if (new TextEncoder().encode(this.content).byteLength > 256 * 1024) return 'This OpenSSH config file is too large for the interactive editor.';
    if (this.content.includes('\u0000')) return 'OpenSSH config text must not contain NUL bytes.';
    return null;
  }

  toArgs(mode: 'validate' | 'apply'): Record<string, string> {
    return {
      ssh_server_action: mode,
      ssh_server_path: this.path,
      ssh_server_content: this.content,
      ssh_server_expected_hash: this.expectedHash,
      ssh_server_main_config: this.mainConfig,
    };
  }
}

export class SSHServerRollbackDraft {
  readonly path: string;
  readonly backupPath: string;

  constructor(path: string, backupPath: string) {
    this.path = path.trim();
    this.backupPath = backupPath.trim();
  }

  validate(): string | null {
    if (!safeOpenSSHConfigPath(this.path)) return 'Choose a supported OpenSSH server config file before rollback.';
    if (!this.backupPath || !this.backupPath.includes('/.shellorchestra-backups/') && !this.backupPath.toLowerCase().includes('\\.shellorchestra-backups\\')) return 'Choose a ShellOrchestra OpenSSH backup before rollback.';
    return null;
  }

  toArgs(): Record<string, string> {
    return {
      ssh_server_action: 'rollback',
      ssh_server_path: this.path,
      ssh_server_backup_path: this.backupPath,
    };
  }
}

export function safeOpenSSHConfigPath(value: string): boolean {
  const path = value.trim().replaceAll('\\', '/');
  if (!path || path.includes('\u0000')) return false;
  if (path === '/etc/ssh/sshd_config' || path === '/usr/local/etc/ssh/sshd_config' || path === '/private/etc/ssh/sshd_config') return true;
  for (const prefix of ['/etc/ssh/sshd_config.d/', '/usr/local/etc/ssh/sshd_config.d/', '/private/etc/ssh/sshd_config.d/']) {
    if (path.startsWith(prefix)) return safeOpenSSHConfName(path.slice(prefix.length));
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('/programdata/ssh/sshd_config') || /^[a-z]:\/programdata\/ssh\/sshd_config$/i.test(path)) return true;
  const marker = '/programdata/ssh/sshd_config.d/';
  const markerIndex = lower.indexOf(marker);
  if (markerIndex >= 0) return safeOpenSSHConfName(path.slice(markerIndex + marker.length));
  return false;
}

function safeOpenSSHConfName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\.conf$/.test(value) && !value.includes('/') && !value.startsWith('.');
}

function normalizeSeverity(value: unknown): SSHServerSeverity {
  if (value === 'critical' || value === 'warning' || value === 'info') return value;
  return '';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}
