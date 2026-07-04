// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { numberOrUndefined } from '../shared';

export type ProcessDTO = {
  pid?: number;
  user?: string;
  cpu_percent?: number;
  cpu_seconds?: number;
  memory_bytes?: number;
  disk_read_bytes?: number;
  disk_write_bytes?: number;
  network_connections?: number;
  network_listening?: number;
  network_established?: number;
  state?: string;
  command?: string;
};

export type ProcessListDTO = {
  generated_at?: string;
  platform?: string;
  source?: string;
  processes?: ProcessDTO[];
};

export type ProcessSignal = 'TERM' | 'KILL' | 'HUP' | 'INT';
export type ProcessSortKey = 'pid' | 'cpu' | 'memory' | 'disk' | 'network';
export type ProcessSortDirection = 'asc' | 'desc';

export class ProcessEntry {
  readonly pid: number;
  readonly user: string;
  readonly cpuPercent?: number;
  readonly cpuSeconds?: number;
  readonly memoryBytes?: number;
  readonly diskReadBytes?: number;
  readonly diskWriteBytes?: number;
  readonly networkConnections?: number;
  readonly networkListening?: number;
  readonly networkEstablished?: number;
  readonly state: string;
  readonly command: string;

  constructor(dto: ProcessDTO) {
    this.pid = numberOrUndefined(dto.pid) ?? 0;
    this.user = typeof dto.user === 'string' ? dto.user : '';
    this.cpuPercent = numberOrUndefined(dto.cpu_percent);
    this.cpuSeconds = numberOrUndefined(dto.cpu_seconds);
    this.memoryBytes = numberOrUndefined(dto.memory_bytes);
    this.diskReadBytes = numberOrUndefined(dto.disk_read_bytes);
    this.diskWriteBytes = numberOrUndefined(dto.disk_write_bytes);
    this.networkConnections = numberOrUndefined(dto.network_connections);
    this.networkListening = numberOrUndefined(dto.network_listening);
    this.networkEstablished = numberOrUndefined(dto.network_established);
    this.state = typeof dto.state === 'string' ? dto.state : '';
    this.command = typeof dto.command === 'string' ? dto.command : '';
  }

  get diskTotalBytes(): number | undefined {
    const read = this.diskReadBytes ?? 0;
    const write = this.diskWriteBytes ?? 0;
    if (this.diskReadBytes === undefined && this.diskWriteBytes === undefined) return undefined;
    return read + write;
  }

  matches(query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${this.pid} ${this.user} ${this.state} ${this.command}`.toLowerCase().includes(needle);
  }
}

export class ProcessCollection {
  readonly items: ProcessEntry[];

  constructor(items: ProcessEntry[]) {
    this.items = items;
  }

  static fromUnknown(value: unknown): ProcessCollection {
    if (!Array.isArray(value)) return new ProcessCollection([]);
    return new ProcessCollection(value.map((item) => new ProcessEntry(item as ProcessDTO)).filter((item) => item.pid > 0));
  }

  filter(query: string): ProcessCollection {
    return new ProcessCollection(this.items.filter((item) => item.matches(query)));
  }

  sortBy(key: ProcessSortKey, direction: ProcessSortDirection): ProcessCollection {
    const multiplier = direction === 'asc' ? 1 : -1;
    const sorted = this.items
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const diff = processSortValue(left.item, key) - processSortValue(right.item, key);
        if (diff !== 0) return diff * multiplier;
        return left.index - right.index;
      })
      .map((entry) => entry.item);
    return new ProcessCollection(sorted);
  }
}

function processSortValue(process: ProcessEntry, key: ProcessSortKey): number {
  if (key === 'pid') return process.pid;
  if (key === 'memory') return process.memoryBytes ?? 0;
  if (key === 'disk') return process.diskTotalBytes ?? -1;
  if (key === 'network') return process.networkConnections ?? -1;
  return process.cpuPercent ?? process.cpuSeconds ?? -1;
}

export class ProcessListPayload {
  readonly generatedAt: string;
  readonly platform: string;
  readonly source: string;
  readonly processes: ProcessCollection;

  constructor(dto: ProcessListDTO) {
    this.generatedAt = typeof dto.generated_at === 'string' ? dto.generated_at : '';
    this.platform = typeof dto.platform === 'string' ? dto.platform : '';
    this.source = typeof dto.source === 'string' ? dto.source : '';
    this.processes = ProcessCollection.fromUnknown(dto.processes);
  }

  static fromUnknown(value: unknown): ProcessListPayload {
    if (!value || typeof value !== 'object') return new ProcessListPayload({});
    return new ProcessListPayload(value as ProcessListDTO);
  }

  updatedLabel(): string {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleTimeString();
  }
}

export class ProcessKillDraft {
  readonly pid: number;
  readonly signal: ProcessSignal;

  constructor(pid: number, signal: ProcessSignal) {
    this.pid = pid;
    this.signal = signal;
  }

  validate(): string | null {
    if (!Number.isInteger(this.pid) || this.pid <= 1) return 'Choose a process id greater than 1.';
    return null;
  }

  toArgs(): Record<string, string> {
    return { process_pid: String(this.pid), process_signal: this.signal };
  }
}
