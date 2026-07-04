// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type DiskRow = {
  id: string;
  level: number;
  name: string;
  type: string;
  size: number;
  free: number;
  fs: string;
  label: string;
  uuid: string;
  mount: string;
  model: string;
  status: string;
};

export type LVMRowKind = 'pv' | 'vg' | 'lv';

export type LVMRow = {
  id: string;
  kind: LVMRowKind;
  name: string;
  group: string;
  path: string;
  size: number;
  free: number;
  attr: string;
  details: string;
};

export class DisksPayload {
  readonly ok: boolean;
  readonly source: string;
  readonly platform: string;
  readonly generatedAt: string;
  readonly rows: DiskRow[];
  readonly lvmRows: LVMRow[];
  readonly lvmAvailable: boolean;
  readonly rawText: string;
  readonly missingUtilities: string[];

  constructor(value: unknown) {
    const dto = objectValue(value);
    this.ok = dto.ok !== false;
    this.source = stringValue(dto.source) || 'unknown';
    this.platform = stringValue(dto.platform) || 'unknown';
    this.generatedAt = stringValue(dto.generated_at);
    this.rawText = stringValue(dto.raw_text);
    this.missingUtilities = stringArrayValue(dto.missing_utilities);
    this.rows = rowsFromPayload(dto);
    const normalizedLVMRows = normalizedLVMRowsFromPayload(dto.lvm_rows);
    const lvm = objectValue(dto.lvm);
    this.lvmRows = normalizedLVMRows.length > 0 ? normalizedLVMRows : rowsFromLVM(lvm);
    this.lvmAvailable = dto.lvm_available === true || lvm.available === true || this.lvmRows.length > 0;
  }

  updatedLabel() {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleString();
  }
}

function rowsFromLVM(lvm: Record<string, unknown>): LVMRow[] {
  const rows: LVMRow[] = [];
  const pvs = lvmReportRows(objectValue(lvm.physical_volumes), 'pv');
  pvs.forEach((item, index) => {
    rows.push({
      id: `lvm-pv-${index}-${stringValue(item.pv_name)}`,
      kind: 'pv',
      name: stringValue(item.pv_name),
      group: stringValue(item.vg_name),
      path: stringValue(item.pv_name),
      size: numberValue(item.pv_size),
      free: numberValue(item.pv_free),
      attr: stringValue(item.pv_attr),
      details: 'Physical volume',
    });
  });
  const vgs = lvmReportRows(objectValue(lvm.volume_groups), 'vg');
  vgs.forEach((item, index) => {
    rows.push({
      id: `lvm-vg-${index}-${stringValue(item.vg_name)}`,
      kind: 'vg',
      name: stringValue(item.vg_name),
      group: '',
      path: '',
      size: numberValue(item.vg_size),
      free: numberValue(item.vg_free),
      attr: stringValue(item.vg_attr),
      details: `${stringValue(item.lv_count) || '0'} LV · ${stringValue(item.pv_count) || '0'} PV`,
    });
  });
  const lvs = lvmReportRows(objectValue(lvm.logical_volumes), 'lv');
  lvs.forEach((item, index) => {
    rows.push({
      id: `lvm-lv-${index}-${stringValue(item.vg_name)}-${stringValue(item.lv_name)}`,
      kind: 'lv',
      name: stringValue(item.lv_name),
      group: stringValue(item.vg_name),
      path: stringValue(item.lv_path),
      size: numberValue(item.lv_size),
      free: 0,
      attr: stringValue(item.lv_attr),
      details: lvmLVDetails(item),
    });
  });
  return rows.filter((row) => row.name || row.path);
}

function lvmReportRows(payload: Record<string, unknown>, key: 'pv' | 'vg' | 'lv'): Record<string, unknown>[] {
  const reports = Array.isArray(payload.report) ? payload.report : [];
  const out: Record<string, unknown>[] = [];
  reports.forEach((report) => {
    const rows = objectValue(report)[key];
    if (Array.isArray(rows)) rows.forEach((row) => out.push(objectValue(row)));
  });
  return out;
}

function lvmLVDetails(item: Record<string, unknown>): string {
  const parts = [
    stringValue(item.origin) ? `origin ${stringValue(item.origin)}` : '',
    stringValue(item.pool_lv) ? `pool ${stringValue(item.pool_lv)}` : '',
    stringValue(item.data_percent) ? `data ${stringValue(item.data_percent)}%` : '',
    stringValue(item.metadata_percent) ? `meta ${stringValue(item.metadata_percent)}%` : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'Logical volume';
}

function rowsFromPayload(dto: Record<string, unknown>): DiskRow[] {
  const normalizedRows = normalizedDiskRowsFromPayload(dto.rows);
  if (normalizedRows.length > 0) return normalizedRows;
  if (Array.isArray(dto.disks)) return rowsFromWindows(dto.disks);
  const diskutil = objectValue(dto.diskutil);
  if (Array.isArray(diskutil.AllDisksAndPartitions)) return rowsFromDiskutil(diskutil.AllDisksAndPartitions);
  const lsblk = objectValue(dto.lsblk);
  const devices = Array.isArray(lsblk.blockdevices) ? lsblk.blockdevices : [];
  return devices.flatMap((device, index) => rowsFromBlockDevice(objectValue(device), 0, `linux-${index}`));
}

function normalizedDiskRowsFromPayload(value: unknown): DiskRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = objectValue(item);
    return {
      id: stringValue(row.id) || `disk-row-${index}`,
      level: numberValue(row.level),
      name: stringValue(row.name),
      type: stringValue(row.type),
      size: numberValue(row.size),
      free: numberValue(row.free),
      fs: stringValue(row.fs),
      label: stringValue(row.label),
      uuid: stringValue(row.uuid),
      mount: stringValue(row.mount),
      model: stringValue(row.model),
      status: stringValue(row.status),
    };
  }).filter((row) => row.name || row.mount || row.uuid || row.type);
}

function normalizedLVMRowsFromPayload(value: unknown): LVMRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const row = objectValue(item);
    const kind = stringValue(row.kind);
    const rowKind: LVMRowKind = kind === 'vg' || kind === 'lv' ? kind : 'pv';
    return {
      id: stringValue(row.id) || `lvm-row-${index}`,
      kind: rowKind,
      name: stringValue(row.name),
      group: stringValue(row.group),
      path: stringValue(row.path),
      size: numberValue(row.size),
      free: numberValue(row.free),
      attr: stringValue(row.attr),
      details: stringValue(row.details),
    };
  }).filter((row) => row.name || row.path);
}

function rowsFromBlockDevice(device: Record<string, unknown>, level: number, id: string): DiskRow[] {
  const row: DiskRow = {
    id,
    level,
    name: stringValue(device.name),
    type: stringValue(device.type),
    size: numberValue(device.size),
    free: numberValue(device.fsavail),
    fs: stringValue(device.fstype),
    label: stringValue(device.label),
    uuid: stringValue(device.uuid),
    mount: stringValue(device.mountpoint),
    model: stringValue(device.model),
    status: stringValue(device.rm) === '1' ? 'removable' : stringValue(device.rota) === '1' ? 'rotational' : '',
  };
  const children = Array.isArray(device.children) ? device.children : [];
  return [row, ...children.flatMap((child, index) => rowsFromBlockDevice(objectValue(child), level + 1, `${id}-${index}`))];
}

function rowsFromDiskutil(disks: unknown[]): DiskRow[] {
  return disks.flatMap((diskValue, diskIndex) => rowsFromDiskutilNode(objectValue(diskValue), 0, `darwin-${diskIndex}`));
}

function rowsFromDiskutilNode(node: Record<string, unknown>, level: number, id: string): DiskRow[] {
  const identifier = stringValue(node.DeviceIdentifier) || stringValue(node.DeviceNode);
  const volumeName = stringValue(node.VolumeName);
  const content = stringValue(node.Content);
  const size = numberValue(node.Size);
  const row: DiskRow = {
    id,
    level,
    name: identifier || volumeName || `disk item ${id}`,
    type: level === 0 ? 'disk' : content || 'partition',
    size,
    free: 0,
    fs: content,
    label: volumeName,
    uuid: stringValue(node.VolumeUUID) || stringValue(node.DiskUUID) || stringValue(node.UUID),
    mount: stringValue(node.MountPoint),
    model: stringValue(node.MediaName) || stringValue(node.IORegistryEntryName),
    status: diskutilStatus(node),
  };
  return [
    row,
    ...diskutilChildren(node).flatMap((child, index) => rowsFromDiskutilNode(objectValue(child), level + 1, `${id}-${index}`)),
  ];
}

function diskutilChildren(node: Record<string, unknown>): unknown[] {
  const children: unknown[] = [];
  for (const key of ['Partitions', 'APFSVolumes', 'APFSPhysicalStores'] as const) {
    const value = node[key];
    if (Array.isArray(value)) children.push(...value);
  }
  return children;
}

function diskutilStatus(node: Record<string, unknown>): string {
  const parts = [
    boolLabel(node.Internal, 'internal'),
    boolLabel(node.OSInternal, 'OS internal'),
    boolLabel(node.Removable, 'removable'),
    stringValue(node.Encryption) ? `encryption ${stringValue(node.Encryption)}` : '',
    stringValue(node.APFSContainerReference) ? `container ${stringValue(node.APFSContainerReference)}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function boolLabel(value: unknown, label: string): string {
  return value === true ? label : '';
}

function rowsFromWindows(disks: unknown[]): DiskRow[] {
  return disks.flatMap((diskValue, diskIndex) => {
    const disk = objectValue(diskValue);
    const diskNumber = stringValue(disk.number) || String(diskIndex);
    const diskRow: DiskRow = {
      id: `win-disk-${diskNumber}`,
      level: 0,
      name: stringValue(disk.name) || `Disk ${diskNumber}`,
      type: stringValue(disk.bus_type) || 'disk',
      size: numberValue(disk.size),
      free: 0,
      fs: stringValue(disk.partition_style),
      label: stringValue(disk.media_type),
      uuid: stringValue(disk.serial),
      mount: '',
      model: stringValue(disk.name),
      status: [stringValue(disk.operational_status), stringValue(disk.health_status)].filter(Boolean).join(' · '),
    };
    const partitions = Array.isArray(disk.partitions) ? disk.partitions : [];
    return [diskRow, ...partitions.map((partitionValue, partitionIndex) => {
      const partition = objectValue(partitionValue);
      const drive = stringValue(partition.drive_letter);
      return {
        id: `win-disk-${diskNumber}-part-${partitionIndex}`,
        level: 1,
        name: `Partition ${stringValue(partition.number) || String(partitionIndex + 1)}`,
        type: stringValue(partition.type) || 'partition',
        size: numberValue(partition.size),
        free: numberValue(partition.size_remaining),
        fs: stringValue(partition.file_system),
        label: stringValue(partition.label),
        uuid: stringValue(partition.gpt_type),
        mount: drive ? `${drive}:\\` : '',
        model: '',
        status: numberValue(partition.size_remaining) > 0 ? `${formatBytes(numberValue(partition.size_remaining))} free` : '',
      };
    })];
  });
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) { next /= 1024; unit += 1; }
  return `${next >= 10 || unit === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[unit]}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
