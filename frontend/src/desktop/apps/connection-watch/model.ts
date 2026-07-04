// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { numberOrUndefined } from '../shared';

export type ConnectionDirection = 'incoming' | 'outgoing' | 'listening' | 'unknown';
export type ConnectionWatchDTO = { generated_at?: string; platform?: string; source?: string; connections?: ConnectionDTO[] };
export type ConnectionDTO = { protocol?: string; direction?: string; state?: string; local_address?: string; local_port?: string | number; remote_address?: string; remote_port?: string | number; process?: string };

export class NetworkConnectionEntry {
  readonly id: string;
  readonly protocol: string;
  readonly direction: ConnectionDirection;
  readonly state: string;
  readonly localAddress: string;
  readonly localPort: string;
  readonly remoteAddress: string;
  readonly remotePort: string;
  readonly process: string;

  constructor(dto: ConnectionDTO, duplicateOrdinal: number) {
    this.protocol = text(dto.protocol).toLowerCase() || 'unknown';
    this.direction = normalizeDirection(dto.direction);
    this.state = text(dto.state);
    this.localAddress = text(dto.local_address);
    this.localPort = text(dto.local_port);
    this.remoteAddress = text(dto.remote_address);
    this.remotePort = text(dto.remote_port);
    this.process = text(dto.process);
    const baseID = connectionIdentityFromFields(this.protocol, this.direction, this.localAddress, this.localPort, this.remoteAddress, this.remotePort);
    this.id = duplicateOrdinal > 1 ? `${baseID}#${duplicateOrdinal}` : baseID;
  }

  matches(query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [this.protocol, this.direction, this.state, this.localAddress, this.localPort, this.remoteAddress, this.remotePort, this.process].join(' ').toLowerCase().includes(needle);
  }

  localEndpoint(): string { return endpoint(this.localAddress, this.localPort); }
  remoteEndpoint(): string { return endpoint(this.remoteAddress, this.remotePort); }
}

export class NetworkConnectionCollection {
  readonly items: NetworkConnectionEntry[];
  constructor(items: NetworkConnectionEntry[]) { this.items = items; }
  static fromUnknown(value: unknown): NetworkConnectionCollection {
    if (!Array.isArray(value)) return new NetworkConnectionCollection([]);
    const seen = new Map<string, number>();
    return new NetworkConnectionCollection(value.map((item) => {
      const dto = item as ConnectionDTO;
      const identity = connectionIdentityFromDTO(dto);
      const ordinal = (seen.get(identity) ?? 0) + 1;
      seen.set(identity, ordinal);
      return new NetworkConnectionEntry(dto, ordinal);
    }));
  }
  filter(query: string): NetworkConnectionCollection { return new NetworkConnectionCollection(this.items.filter((item) => item.matches(query))); }
  byDirection(direction: ConnectionDirection): NetworkConnectionEntry[] { return this.items.filter((item) => item.direction === direction || (direction === 'outgoing' && item.direction === 'unknown')); }
  count(direction: ConnectionDirection): number { return this.byDirection(direction).length; }
}

export class ConnectionWatchPayload {
  readonly generatedAt: string;
  readonly platform: string;
  readonly source: string;
  readonly connections: NetworkConnectionCollection;
  constructor(dto: ConnectionWatchDTO) {
    this.generatedAt = text(dto.generated_at);
    this.platform = text(dto.platform);
    this.source = text(dto.source);
    this.connections = NetworkConnectionCollection.fromUnknown(dto.connections);
  }
  static fromUnknown(value: unknown): ConnectionWatchPayload { if (!value || typeof value !== 'object') return new ConnectionWatchPayload({}); return new ConnectionWatchPayload(value as ConnectionWatchDTO); }
  updatedLabel(): string { if (!this.generatedAt) return '—'; const date = new Date(this.generatedAt); if (Number.isNaN(date.getTime())) return this.generatedAt; return date.toLocaleTimeString(); }
}

function normalizeDirection(value: unknown): ConnectionDirection {
  const direction = text(value).toLowerCase();
  if (direction === 'incoming' || direction === 'outgoing' || direction === 'listening') return direction;
  return 'unknown';
}
function text(value: unknown): string { if (typeof value === 'string') return value.trim(); const number = numberOrUndefined(value); return number === undefined ? '' : String(number); }
function endpoint(address: string, port: string): string { if (!address && !port) return '—'; if (!port) return address || '—'; if (!address) return port; return `${address}:${port}`; }

function connectionIdentityFromDTO(dto: ConnectionDTO): string {
  return connectionIdentityFromFields(
    text(dto.protocol).toLowerCase() || 'unknown',
    normalizeDirection(dto.direction),
    text(dto.local_address),
    text(dto.local_port),
    text(dto.remote_address),
    text(dto.remote_port),
  );
}

function connectionIdentityFromFields(protocol: string, direction: ConnectionDirection, localAddress: string, localPort: string, remoteAddress: string, remotePort: string): string {
  return [protocol, direction, localAddress, localPort, remoteAddress, remotePort].map(identityPart).join('|');
}

function identityPart(value: string): string {
  return encodeURIComponent(value || '—');
}
