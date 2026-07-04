// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type ServiceDTO = { name?: string; load?: string; active?: string; sub?: string; description?: string };
export type ServicesDTO = { generated_at?: string; manager?: string; services?: ServiceDTO[] };
export type ServiceUnitFileDTO = { generated_at?: string; manager?: string; service?: string; unit_file_path?: string };
export type ServiceDetailsDTO = {
  generated_at?: string;
  manager?: string;
  service?: string;
  load_state?: string;
  active_state?: string;
  sub_state?: string;
  unit_file_state?: string;
  fragment_path?: string;
  active_enter_timestamp?: string;
  inactive_enter_timestamp?: string;
  exec_main_pid?: string;
  exec_main_code?: string;
  exec_main_status?: string;
  result?: string;
  status_text?: string;
};
export type ServiceLogDTO = { timestamp?: string; message?: string };
export type ServiceLogsDTO = { generated_at?: string; manager?: string; service?: string; logs?: ServiceLogDTO[] };
export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload';

export class ServiceUnit {
  readonly id: string;
  readonly name: string;
  readonly load: string;
  readonly active: string;
  readonly sub: string;
  readonly description: string;
  readonly displayName: string;

  constructor(dto: ServiceDTO, index: number) {
    this.name = typeof dto.name === 'string' ? dto.name : '';
    this.load = typeof dto.load === 'string' ? dto.load : '';
    this.active = typeof dto.active === 'string' ? dto.active : '';
    this.sub = typeof dto.sub === 'string' ? dto.sub : '';
    this.description = typeof dto.description === 'string' ? dto.description : '';
    this.displayName = this.name || `Service ${index + 1}`;
    this.id = `${this.name || 'unnamed'}:${index}`;
  }

  matches(query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${this.displayName} ${this.name} ${this.active} ${this.sub} ${this.description}`.toLowerCase().includes(needle);
  }

  canRunAction(): boolean {
    return /^[A-Za-z0-9@_. :\-]+(\.service)?$/.test(this.name);
  }
}

export class ServiceUnitCollection {
  readonly items: ServiceUnit[];
  constructor(items: ServiceUnit[]) { this.items = items; }
  static fromUnknown(value: unknown): ServiceUnitCollection {
    if (!Array.isArray(value)) return new ServiceUnitCollection([]);
    return new ServiceUnitCollection(value.map((item, index) => new ServiceUnit(item as ServiceDTO, index)).filter((item) => item.name || item.description));
  }
  filter(query: string): ServiceUnitCollection { return new ServiceUnitCollection(this.items.filter((item) => item.matches(query))); }
}

export class ServicesPayload {
  readonly generatedAt: string;
  readonly manager: string;
  readonly services: ServiceUnitCollection;
  constructor(dto: ServicesDTO) {
    this.generatedAt = typeof dto.generated_at === 'string' ? dto.generated_at : '';
    this.manager = typeof dto.manager === 'string' && dto.manager ? dto.manager : 'unknown';
    this.services = ServiceUnitCollection.fromUnknown(dto.services);
  }
  static fromUnknown(value: unknown): ServicesPayload {
    if (!value || typeof value !== 'object') return new ServicesPayload({});
    return new ServicesPayload(value as ServicesDTO);
  }
  updatedLabel(): string {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleTimeString();
  }
}

export class ServiceUnitFilePayload {
  readonly generatedAt: string;
  readonly manager: string;
  readonly service: string;
  readonly unitFilePath: string;
  constructor(dto: ServiceUnitFileDTO) {
    this.generatedAt = typeof dto.generated_at === 'string' ? dto.generated_at : '';
    this.manager = typeof dto.manager === 'string' && dto.manager ? dto.manager : 'unknown';
    this.service = typeof dto.service === 'string' ? dto.service : '';
    this.unitFilePath = typeof dto.unit_file_path === 'string' ? dto.unit_file_path.trim() : '';
  }
  static fromUnknown(value: unknown): ServiceUnitFilePayload {
    if (!value || typeof value !== 'object') return new ServiceUnitFilePayload({});
    return new ServiceUnitFilePayload(value as ServiceUnitFileDTO);
  }
  unavailableReason(): string {
    if (this.unitFilePath) return '';
    if (this.manager !== 'systemd') return 'This server does not expose systemd unit files through the Services app.';
    return 'The selected service does not have a regular unit file on disk. It may be generated, transient, or provided by another service manager.';
  }
}

export class ServiceDetailsPayload {
  readonly generatedAt: string;
  readonly manager: string;
  readonly service: string;
  readonly loadState: string;
  readonly activeState: string;
  readonly subState: string;
  readonly unitFileState: string;
  readonly fragmentPath: string;
  readonly activeEnterTimestamp: string;
  readonly inactiveEnterTimestamp: string;
  readonly execMainPID: string;
  readonly execMainCode: string;
  readonly execMainStatus: string;
  readonly result: string;
  readonly statusText: string;

  constructor(dto: ServiceDetailsDTO) {
    this.generatedAt = typeof dto.generated_at === 'string' ? dto.generated_at : '';
    this.manager = typeof dto.manager === 'string' && dto.manager ? dto.manager : 'unknown';
    this.service = typeof dto.service === 'string' ? dto.service : '';
    this.loadState = typeof dto.load_state === 'string' ? dto.load_state : '';
    this.activeState = typeof dto.active_state === 'string' ? dto.active_state : '';
    this.subState = typeof dto.sub_state === 'string' ? dto.sub_state : '';
    this.unitFileState = typeof dto.unit_file_state === 'string' ? dto.unit_file_state : '';
    this.fragmentPath = typeof dto.fragment_path === 'string' ? dto.fragment_path : '';
    this.activeEnterTimestamp = typeof dto.active_enter_timestamp === 'string' ? dto.active_enter_timestamp : '';
    this.inactiveEnterTimestamp = typeof dto.inactive_enter_timestamp === 'string' ? dto.inactive_enter_timestamp : '';
    this.execMainPID = typeof dto.exec_main_pid === 'string' ? dto.exec_main_pid : '';
    this.execMainCode = typeof dto.exec_main_code === 'string' ? dto.exec_main_code : '';
    this.execMainStatus = typeof dto.exec_main_status === 'string' ? dto.exec_main_status : '';
    this.result = typeof dto.result === 'string' ? dto.result : '';
    this.statusText = typeof dto.status_text === 'string' ? dto.status_text : '';
  }

  static fromUnknown(value: unknown): ServiceDetailsPayload {
    if (!value || typeof value !== 'object') return new ServiceDetailsPayload({});
    return new ServiceDetailsPayload(value as ServiceDetailsDTO);
  }

  updatedLabel(): string {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleTimeString();
  }
}

export class ServiceLogEntry {
  readonly timestamp: string;
  readonly message: string;
  constructor(dto: ServiceLogDTO) {
    this.timestamp = typeof dto.timestamp === 'string' ? dto.timestamp.trim() : '';
    this.message = typeof dto.message === 'string' ? dto.message : '';
  }
}

export class ServiceLogsPayload {
  readonly generatedAt: string;
  readonly manager: string;
  readonly service: string;
  readonly logs: ServiceLogEntry[];
  constructor(dto: ServiceLogsDTO) {
    this.generatedAt = typeof dto.generated_at === 'string' ? dto.generated_at : '';
    this.manager = typeof dto.manager === 'string' && dto.manager ? dto.manager : 'unknown';
    this.service = typeof dto.service === 'string' ? dto.service : '';
    this.logs = Array.isArray(dto.logs) ? dto.logs.map((item) => new ServiceLogEntry(item)).filter((item) => item.message || item.timestamp) : [];
  }
  static fromUnknown(value: unknown): ServiceLogsPayload {
    if (!value || typeof value !== 'object') return new ServiceLogsPayload({});
    return new ServiceLogsPayload(value as ServiceLogsDTO);
  }
  updatedLabel(): string {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleTimeString();
  }
}

export class ServiceActionDraft {
  readonly serviceName: string;
  readonly action: ServiceAction;
  constructor(serviceName: string, action: ServiceAction) { this.serviceName = serviceName.trim(); this.action = action; }
  validate(): string | null {
    if (!/^[A-Za-z0-9@_. :\-]+(\.service)?$/.test(this.serviceName)) return 'Choose a safe service name.';
    return null;
  }
  toArgs(): Record<string, string> { return { service_name: this.serviceName, service_action: this.action }; }
}
