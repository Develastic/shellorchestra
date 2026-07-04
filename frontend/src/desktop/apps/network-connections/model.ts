// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type NetworkAdapterDTO = { name?: string; type?: string; state?: string; mtu?: string; mac?: string; gateway?: string; addresses?: string[] };
export type NetworkRouteDTO = { destination?: string; gateway?: string; interface_name?: string; source_address?: string; metric?: string; is_default?: boolean };
export type NetworkSshPathDTO = { client_address?: string; server_address?: string; server_port?: string; interface_name?: string; source_address?: string; route_known?: boolean };
export type NetworkConnectionsDTO = { platform?: string; manager?: string; hostname?: string; dns?: string[]; dns_search_domains?: string[]; routes?: NetworkRouteDTO[]; ssh_path?: NetworkSshPathDTO; message?: string; adapters?: NetworkAdapterDTO[] };

export class NetworkAdapter {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly state: string;
  readonly mtu: string;
  readonly mac: string;
  readonly gateway: string;
  readonly addresses: string[];
  constructor(dto: NetworkAdapterDTO, index: number) {
    this.name = text(dto.name);
    this.type = text(dto.type);
    this.state = text(dto.state);
    this.mtu = text(dto.mtu);
    this.mac = text(dto.mac);
    this.gateway = text(dto.gateway);
    this.addresses = Array.isArray(dto.addresses) ? dto.addresses.map(text).filter(Boolean) : [];
    this.id = `${this.name || 'adapter'}-${this.mac || index}`;
  }
  matches(query: string): boolean { const needle = query.trim().toLowerCase(); if (!needle) return true; return [this.name, this.type, this.state, this.mac, this.gateway, ...this.addresses].some((value) => value.toLowerCase().includes(needle)); }
  stateLabel(): string { return this.state || 'unknown'; }
}

export class NetworkAdapterCollection {
  readonly items: NetworkAdapter[];
  constructor(items: NetworkAdapter[]) { this.items = items; }
  static fromUnknown(value: unknown): NetworkAdapterCollection { if (!Array.isArray(value)) return new NetworkAdapterCollection([]); return new NetworkAdapterCollection(value.map((item, index) => new NetworkAdapter(item as NetworkAdapterDTO, index)).filter((item) => item.name)); }
  filter(query: string): NetworkAdapterCollection { return new NetworkAdapterCollection(this.items.filter((item) => item.matches(query))); }
  first(): NetworkAdapter | null { return this.items[0] ?? null; }
}


export class NetworkRoute {
  readonly id: string;
  readonly destination: string;
  readonly gateway: string;
  readonly interfaceName: string;
  readonly sourceAddress: string;
  readonly metric: string;
  readonly isDefault: boolean;
  constructor(dto: NetworkRouteDTO, index: number) {
    this.destination = text(dto.destination);
    this.gateway = text(dto.gateway);
    this.interfaceName = text(dto.interface_name);
    this.sourceAddress = text(dto.source_address);
    this.metric = text(dto.metric);
    this.isDefault = Boolean(dto.is_default) || this.destination === 'default' || this.destination === '0.0.0.0/0' || this.destination === '::/0';
    this.id = `${this.destination || 'route'}-${this.interfaceName || 'iface'}-${this.gateway || 'gateway'}-${index}`;
  }
  matches(query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [this.destination, this.gateway, this.interfaceName, this.sourceAddress, this.metric].some((value) => value.toLowerCase().includes(needle));
  }
}

export class NetworkRouteCollection {
  readonly items: NetworkRoute[];
  constructor(items: NetworkRoute[]) { this.items = items; }
  static fromUnknown(value: unknown): NetworkRouteCollection {
    if (!Array.isArray(value)) return new NetworkRouteCollection([]);
    return new NetworkRouteCollection(value.map((item, index) => new NetworkRoute(item as NetworkRouteDTO, index)).filter((item) => item.destination || item.gateway || item.interfaceName));
  }
  filter(query: string): NetworkRouteCollection { return new NetworkRouteCollection(this.items.filter((item) => item.matches(query))); }
  defaultRoutes(): NetworkRoute[] { return this.items.filter((route) => route.isDefault); }
  forAdapter(adapter: NetworkAdapter | null): NetworkRoute[] {
    if (!adapter) return this.items;
    const name = adapter.name.toLowerCase();
    return this.items.filter((route) => route.interfaceName.toLowerCase() === name);
  }
}

export class NetworkSshPath {
  readonly clientAddress: string;
  readonly serverAddress: string;
  readonly serverPort: string;
  readonly interfaceName: string;
  readonly sourceAddress: string;
  readonly routeKnown: boolean;
  constructor(dto: NetworkSshPathDTO = {}) {
    this.clientAddress = text(dto.client_address);
    this.serverAddress = text(dto.server_address);
    this.serverPort = text(dto.server_port);
    this.interfaceName = text(dto.interface_name);
    this.sourceAddress = text(dto.source_address);
    this.routeKnown = Boolean(dto.route_known) && this.interfaceName !== '';
  }
  carries(adapter: NetworkAdapter | null): boolean {
    if (!adapter || !this.routeKnown) return false;
    return adapter.name.toLowerCase() === this.interfaceName.toLowerCase();
  }
  summary(): string {
    if (!this.clientAddress && !this.serverAddress) return '';
    const endpoint = this.serverPort ? `${this.serverAddress}:${this.serverPort}` : this.serverAddress;
    return `${this.clientAddress || 'unknown client'} → ${endpoint || 'unknown server'}`;
  }
}

export class NetworkConnectionsPayload {
  readonly platform: string;
  readonly manager: string;
  readonly hostname: string;
  readonly dns: string[];
  readonly dnsSearchDomains: string[];
  readonly routes: NetworkRouteCollection;
  readonly sshPath: NetworkSshPath;
  readonly message: string;
  readonly adapters: NetworkAdapterCollection;
  constructor(dto: NetworkConnectionsDTO) {
    this.platform = text(dto.platform);
    this.manager = text(dto.manager);
    this.hostname = text(dto.hostname);
    this.dns = Array.isArray(dto.dns) ? dto.dns.map(text).filter(Boolean) : [];
    this.dnsSearchDomains = Array.isArray(dto.dns_search_domains) ? dto.dns_search_domains.map(text).filter(Boolean) : [];
    this.routes = NetworkRouteCollection.fromUnknown(dto.routes);
    this.sshPath = new NetworkSshPath(dto.ssh_path);
    this.message = text(dto.message);
    this.adapters = NetworkAdapterCollection.fromUnknown(dto.adapters);
  }
  static fromUnknown(value: unknown): NetworkConnectionsPayload { if (!value || typeof value !== 'object') return new NetworkConnectionsPayload({ message: 'Network Connections did not receive a valid response from the server.' }); return new NetworkConnectionsPayload(value as NetworkConnectionsDTO); }
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
