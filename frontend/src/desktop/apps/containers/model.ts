// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type ContainerDTO = {
  id?: string;
  image?: string;
  name?: string;
  state?: string;
  status?: string;
  ports?: string;
  created_at?: string;
  running_for?: string;
  size?: string;
  command?: string;
  labels?: string;
  mounts?: string;
  networks?: string;
  restart_policy?: string;
};
export type ContainerImageDTO = { repository?: string; tag?: string; id?: string; size?: string };
export type ContainerVolumeDTO = { driver?: string; name?: string; mountpoint?: string };
export type ContainerNetworkDTO = { id?: string; name?: string; driver?: string; scope?: string };
export type ContainersPayloadDTO = { generated_at?: string; engine?: string; engine_error?: string; errors?: string[]; query?: string; state_token?: string; not_modified?: boolean; containers?: ContainerDTO[]; images?: ContainerImageDTO[]; volumes?: ContainerVolumeDTO[]; networks?: ContainerNetworkDTO[] };
export type ContainerLifecycleAction = 'start' | 'stop' | 'restart';
export type ContainerInstallTemplateID = 'nginx' | 'custom';
export type ContainerAction = ContainerLifecycleAction | 'logs' | 'install';

export class ContainerEntry {
  readonly id: string;
  readonly image: string;
  readonly name: string;
  readonly state: string;
  readonly status: string;
  readonly ports: string;
  readonly createdAt: string;
  readonly runningFor: string;
  readonly size: string;
  readonly command: string;
  readonly labels: string;
  readonly mounts: string;
  readonly networks: string;
  readonly restartPolicy: string;
  constructor(dto: ContainerDTO, index: number) {
    this.id = text(dto.id) || `container-${index}`;
    this.image = text(dto.image);
    this.name = text(dto.name);
    this.state = text(dto.state);
    this.status = text(dto.status);
    this.ports = text(dto.ports);
    this.createdAt = text(dto.created_at);
    this.runningFor = text(dto.running_for);
    this.size = text(dto.size);
    this.command = text(dto.command);
    this.labels = text(dto.labels);
    this.mounts = text(dto.mounts);
    this.networks = text(dto.networks);
    this.restartPolicy = text(dto.restart_policy);
  }
  get displayName(): string { return this.name || this.id; }
  matches(query: string): boolean { const needle = query.trim().toLowerCase(); return !needle || `${this.id} ${this.image} ${this.name} ${this.state} ${this.status} ${this.ports} ${this.command} ${this.labels} ${this.mounts} ${this.networks}`.toLowerCase().includes(needle); }
  matchesImage(query: string): boolean { const needle = query.trim().toLowerCase(); return !needle || this.image.toLowerCase().includes(needle); }
  isRunning(): boolean { return this.state.toLowerCase() === 'running' || this.status.toLowerCase().startsWith('up '); }
  canRunAction(): boolean { return /^[A-Za-z0-9_.:-]{1,128}$/.test(this.id) || /^[A-Za-z0-9_.:-]{1,128}$/.test(this.name); }
  actionTarget(): string { return /^[A-Za-z0-9_.:-]{1,128}$/.test(this.id) ? this.id : this.name; }
  inspectObject(): Record<string, string> {
    return {
      id: this.id,
      name: this.name,
      image: this.image,
      state: this.state,
      status: this.status,
      ports: this.ports,
      created_at: this.createdAt,
      running_for: this.runningFor,
      size: this.size,
      command: this.command,
      labels: this.labels,
      mounts: this.mounts,
      networks: this.networks,
      restart_policy: this.restartPolicy,
    };
  }
}

export class ContainerCollection {
  readonly items: ContainerEntry[];
  constructor(items: ContainerEntry[]) { this.items = items; }
  static fromUnknown(value: unknown): ContainerCollection { return Array.isArray(value) ? new ContainerCollection(value.map((item, index) => new ContainerEntry(item as ContainerDTO, index)).filter((item) => item.displayName)) : new ContainerCollection([]); }
  filter(query: string): ContainerCollection { return new ContainerCollection(this.items.filter((item) => item.matches(query))); }
}

export class ContainersPayload {
  readonly generatedAt: string;
  readonly engine: string;
  readonly engineError: string;
  readonly errors: string[];
  readonly query: string;
  readonly stateToken: string;
  readonly notModified: boolean;
  readonly containers: ContainerCollection;
  readonly images: ContainerImageDTO[];
  readonly volumes: ContainerVolumeDTO[];
  readonly networks: ContainerNetworkDTO[];
  constructor(dto: ContainersPayloadDTO) {
    this.generatedAt = text(dto.generated_at);
    this.engine = text(dto.engine) || 'unknown';
    this.engineError = text(dto.engine_error);
    this.errors = arrayText(dto.errors);
    this.query = text(dto.query);
    this.stateToken = text(dto.state_token);
    this.notModified = dto.not_modified === true;
    this.containers = ContainerCollection.fromUnknown(dto.containers);
    this.images = arrayObjects(dto.images);
    this.volumes = arrayObjects(dto.volumes);
    this.networks = arrayObjects(dto.networks);
  }
  static fromUnknown(value: unknown): ContainersPayload { return value && typeof value === 'object' ? new ContainersPayload(value as ContainersPayloadDTO) : new ContainersPayload({}); }
  updatedLabel(): string { if (!this.generatedAt) return '—'; const date = new Date(this.generatedAt); return Number.isNaN(date.getTime()) ? this.generatedAt : date.toLocaleTimeString(); }
  withRefreshMetadata(dto: Pick<ContainersPayload, 'generatedAt' | 'stateToken' | 'notModified'>): ContainersPayload {
    return new ContainersPayload({
      generated_at: dto.generatedAt || this.generatedAt,
      engine: this.engine,
      engine_error: this.engineError,
      errors: this.errors,
      query: this.query,
      state_token: dto.stateToken || this.stateToken,
      not_modified: false,
      containers: this.containers.items.map((item) => item.inspectObject()),
      images: this.images,
      volumes: this.volumes,
      networks: this.networks,
    });
  }
  engineLabel(): string { if (this.engine === 'docker') return 'Docker'; if (this.engine === 'podman') return 'Podman'; if (this.engine === 'none') return 'No engine'; return this.engine || 'Unknown'; }
  runningCount(): number { return this.containers.items.filter((item) => item.isRunning()).length; }
  stoppedCount(): number { return Math.max(0, this.containers.items.length - this.runningCount()); }
  hasEngineProblem(): boolean { return this.engine === 'none' || this.engine === 'unknown' || Boolean(this.engineError || this.errors.length); }
}

export class ContainerActionDraft {
  readonly action: ContainerLifecycleAction;
  readonly target: string;
  readonly engine: string;
  constructor(input: { action: ContainerLifecycleAction; target: string; engine: string }) { this.action = input.action; this.target = input.target.trim(); this.engine = input.engine.trim() || 'auto'; }
  validate(): string | null { if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(this.target)) return 'Choose a safe container id or name.'; if (this.action !== 'start' && this.action !== 'stop' && this.action !== 'restart') return 'Choose a supported container action.'; return null; }
  toArgs(): Record<string, string> { return { container_action: this.action, container_id: this.target, container_engine: this.engine }; }
}


export class ContainerInstallDraft {
  readonly action = 'install' as const;
  readonly templateID: ContainerInstallTemplateID;
  readonly image: string;
  readonly name: string;
  readonly engine: string;
  readonly bindAddress: string;
  readonly hostPort: number;
  readonly containerPort: number;
  readonly restartPolicy: string;
  readonly exposureConfirmed: boolean;
  constructor(input: { templateID: ContainerInstallTemplateID; image: string; name: string; engine: string; bindAddress: string; hostPort: number; containerPort: number; restartPolicy: string; exposureConfirmed: boolean }) {
    this.templateID = input.templateID;
    this.image = input.image.trim();
    this.name = input.name.trim();
    this.engine = input.engine.trim() || 'auto';
    this.bindAddress = input.bindAddress.trim() || '127.0.0.1';
    this.hostPort = Math.round(input.hostPort || 0);
    this.containerPort = Math.round(input.containerPort || 0);
    this.restartPolicy = input.restartPolicy.trim() || 'unless-stopped';
    this.exposureConfirmed = input.exposureConfirmed;
  }
  validate(): string | null {
    if (this.templateID !== 'nginx' && this.templateID !== 'custom') return 'Choose a supported install template.';
    if (this.engine !== 'auto' && this.engine !== 'docker' && this.engine !== 'podman') return 'Choose Docker, Podman, or auto engine detection.';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(this.name)) return 'Use a safe container name: letters, digits, dot, underscore, or dash.';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(this.image)) return 'Use a safe image reference.';
    if (!isPort(this.hostPort)) return 'Choose a host port between 1 and 65535.';
    if (!isPort(this.containerPort)) return 'Choose a container port between 1 and 65535.';
    if (!/^(127\.0\.0\.1|localhost|0\.0\.0\.0|::1)$/.test(this.bindAddress)) return 'Use 127.0.0.1, localhost, ::1, or 0.0.0.0 as the bind address.';
    if (!this.exposureConfirmed && this.bindAddress !== '127.0.0.1' && this.bindAddress !== 'localhost' && this.bindAddress !== '::1') return 'Confirm network exposure before binding outside localhost.';
    if (this.restartPolicy !== 'unless-stopped' && this.restartPolicy !== 'no') return 'Choose a supported restart policy.';
    return null;
  }
  toArgs(): Record<string, string> {
    return {
      container_action: this.action,
      container_engine: this.engine,
      container_install_template: this.templateID,
      container_install_image: this.image,
      container_install_name: this.name,
      container_install_bind_address: this.bindAddress,
      container_install_host_port: String(this.hostPort),
      container_install_container_port: String(this.containerPort),
      container_install_restart_policy: this.restartPolicy,
      container_install_exposure_confirmed: this.exposureConfirmed ? 'true' : 'false',
    };
  }
}

function isPort(value: number): boolean { return Number.isInteger(value) && value >= 1 && value <= 65535; }

export class ContainerLogsDraft {
  readonly target: string;
  readonly engine: string;
  readonly tailLines: number;
  constructor(input: { target: string; engine: string; tailLines: number }) {
    this.target = input.target.trim();
    this.engine = input.engine.trim() || 'auto';
    this.tailLines = Math.max(1, Math.min(5000, Math.round(input.tailLines || 300)));
  }
  validate(): string | null {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(this.target)) return 'Choose a safe container id or name.';
    if (this.engine !== 'auto' && this.engine !== 'docker' && this.engine !== 'podman') return 'Choose Docker, Podman, or auto engine detection.';
    if (!Number.isFinite(this.tailLines) || this.tailLines < 1 || this.tailLines > 5000) return 'Choose a log tail size between 1 and 5000 lines.';
    return null;
  }
  toArgs(): Record<string, string> { return { container_action: 'logs', container_id: this.target, container_engine: this.engine, container_logs_tail: String(this.tailLines) }; }
}

function text(value: unknown): string { if (typeof value === 'string') return value.trim(); if (typeof value === 'number' || typeof value === 'boolean') return String(value); return ''; }
function arrayObjects<T>(value: unknown): T[] { return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as T[] : []; }
function arrayText(value: unknown): string[] { return Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 12) : []; }
