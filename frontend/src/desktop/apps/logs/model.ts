// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type LogEntryDTO = { timestamp?: string; host?: string; unit?: string; priority?: string; message?: string };
export type LogsPayloadDTO = { generated_at?: string; platform?: string; source?: string; path?: string; format?: string; query?: string; unit?: string; priority?: string; since?: string; until?: string; cursor?: string; follow?: boolean; follow_reset?: boolean; follow_partial?: boolean; scanned_bytes?: number; entries?: LogEntryDTO[]; raw_text?: string };

export class LogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly host: string;
  readonly unit: string;
  readonly priority: string;
  readonly message: string;

  constructor(dto: LogEntryDTO, index: number) {
    this.timestamp = text(dto.timestamp);
    this.host = text(dto.host);
    this.unit = text(dto.unit);
    this.priority = text(dto.priority);
    this.message = text(dto.message);
    this.id = `${this.timestamp}-${this.unit}-${index}`;
  }

  matches(query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${this.timestamp} ${this.host} ${this.unit} ${this.priority} ${this.message}`.toLowerCase().includes(needle);
  }

  displayTimestamp(): string {
    if (!this.timestamp) return '—';
    const date = new Date(this.timestamp);
    if (Number.isNaN(date.getTime())) return this.timestamp;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
}

export class LogEntryCollection {
  readonly items: LogEntry[];
  constructor(items: LogEntry[]) { this.items = items; }
  static fromUnknown(value: unknown): LogEntryCollection {
    if (!Array.isArray(value)) return new LogEntryCollection([]);
    return new LogEntryCollection(value.map((item, index) => new LogEntry(item as LogEntryDTO, index)).filter((entry) => entry.message));
  }
  filter(query: string): LogEntryCollection { return new LogEntryCollection(this.items.filter((entry) => entry.matches(query))); }
}

export class LogsPayload {
  readonly generatedAt: string;
  readonly platform: string;
  readonly source: string;
  readonly path: string;
  readonly format: string;
  readonly query: string;
  readonly unit: string;
  readonly priority: string;
  readonly since: string;
  readonly until: string;
  readonly entries: LogEntryCollection;
  readonly cursor: string;
  readonly follow: boolean;
  readonly followReset: boolean;
  readonly followPartial: boolean;
  readonly scannedBytes: number;
  readonly rawText: string;

  constructor(dto: LogsPayloadDTO) {
    this.generatedAt = text(dto.generated_at);
    this.platform = text(dto.platform);
    this.source = text(dto.source) || 'unknown';
    this.path = text(dto.path);
    this.format = text(dto.format) || 'unknown';
    this.query = text(dto.query);
    this.unit = text(dto.unit);
    this.priority = text(dto.priority);
    this.since = text(dto.since);
    this.until = text(dto.until);
    this.cursor = text(dto.cursor);
    this.follow = dto.follow === true;
    this.followReset = dto.follow_reset === true;
    this.followPartial = dto.follow_partial === true;
    this.scannedBytes = typeof dto.scanned_bytes === 'number' && Number.isFinite(dto.scanned_bytes) ? dto.scanned_bytes : 0;
    this.entries = LogEntryCollection.fromUnknown(dto.entries);
    this.rawText = text(dto.raw_text);
  }

  static fromUnknown(value: unknown): LogsPayload {
    if (!value || typeof value !== 'object') return new LogsPayload({});
    return new LogsPayload(value as LogsPayloadDTO);
  }

  updatedLabel(): string {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleTimeString();
  }
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
