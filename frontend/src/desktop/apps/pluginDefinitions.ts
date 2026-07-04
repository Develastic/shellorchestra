// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { components } from '../../api/schema';

export type DesktopAppModuleID =
  | 'terminal'
  | 'terminal_profile'
  | 'package_manager'
  | 'process_monitor'
  | 'file_manager'
  | 'document_viewer'
  | 'spreadsheet_viewer'
  | 'editor'
  | 'containers'
  | 'logs'
  | 'services'
  | 'ssh_server'
  | 'network_connections'
  | 'connection_watch'
  | 'custom_shortcuts'
  | 'lan_watch'
  | 'users'
  | 'cron_editor'
  | 'sudo_editor'
  | 'firewall'
  | 'disks'
  | 'pve_manager'
  | 'speed_test';

export type DesktopWindowKind = 'terminal' | 'package_manager' | 'process_monitor' | 'file_manager' | 'document_viewer' | 'spreadsheet_viewer' | 'containers' | 'logs' | 'services' | 'network_connections' | 'connection_watch' | 'custom_shortcuts' | 'lan_watch' | 'users' | 'cron_editor' | 'sudo_editor' | 'firewall' | 'disks' | 'pve_manager' | 'speed_test' | 'editor' | 'ssh_server';
export type DesktopAppBackendDriver = 'terminal' | 'script_data' | 'script_action' | 'speed_test' | 'ui';
export type DesktopAppEdition = 'community' | 'pro' | 'business' | 'enterprise';
export type DesktopAppSandboxPolicy = 'main' | 'iframe-terminal' | 'sandboxed-preview' | 'sandboxed-editor';
export type DesktopApp = components['schemas']['DesktopApp'];

export type DesktopAppWindowDefaults = {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  maximized: boolean;
};

export type DesktopAppPluginDefinition = {
  id: string;
  pluginID: string;
  edition: DesktopAppEdition;
  title: string;
  description: string;
  kind: DesktopWindowKind;
  frontendModule: DesktopAppModuleID;
  backendDriver: DesktopAppBackendDriver;
  icon: string;
  integratedWindow: boolean;
  opensInteractiveTerminal: boolean;
  sandboxPolicy: DesktopAppSandboxPolicy;
  capabilities: string[];
  permissions: string[];
  window: DesktopAppWindowDefaults;
  dataRefreshIntervalSeconds: number;
  dataMonitorIntervalSeconds: number;
  dataMonitorTTLSeconds: number;
};

export class DesktopAppPluginRegistry {
  readonly plugins: DesktopAppPluginDefinition[];
  private readonly byModule = new Map<DesktopAppModuleID, DesktopAppPluginDefinition>();
  private readonly byKind = new Map<DesktopWindowKind, DesktopAppPluginDefinition>();
  private readonly byID = new Map<string, DesktopAppPluginDefinition>();

  constructor(plugins: DesktopAppPluginDefinition[]) {
    this.plugins = plugins.map(normalizePluginDefinition);
    for (const plugin of this.plugins) {
      this.byID.set(plugin.id, plugin);
      if (!this.byModule.has(plugin.frontendModule)) this.byModule.set(plugin.frontendModule, plugin);
      if (!this.byKind.has(plugin.kind)) this.byKind.set(plugin.kind, plugin);
    }
  }

  app(appID: string | null | undefined): DesktopAppPluginDefinition | undefined {
    return this.byID.get((appID ?? '').trim());
  }

  module(moduleID: string | null | undefined): DesktopAppPluginDefinition | undefined {
    const normalized = normalizeDesktopAppModuleID(moduleID ?? '');
    return normalized ? this.byModule.get(normalized) : undefined;
  }

  kind(kind: string | null | undefined): DesktopAppPluginDefinition | undefined {
    const normalized = normalizeDesktopWindowKind(kind ?? '');
    return normalized ? this.byKind.get(normalized) : undefined;
  }

  supportedWindowKind(value: unknown): value is DesktopWindowKind {
    return typeof value === 'string' && Boolean(this.kind(value));
  }

  windowDefaults(kind: DesktopWindowKind): DesktopAppWindowDefaults {
    return this.kind(kind)?.window ?? { width: 640, height: 390, minWidth: 360, minHeight: 240, maximized: true };
  }

  windowDefaultsFor(kind: DesktopWindowKind, appID?: string | null, moduleID?: string | null): DesktopAppWindowDefaults {
    return this.app(appID)?.window
      ?? this.module(moduleID)?.window
      ?? this.windowDefaults(kind);
  }

  titleForKind(kind: DesktopWindowKind): string {
    return this.kind(kind)?.title ?? 'Window';
  }
}

export const desktopAppPlugins = new DesktopAppPluginRegistry([
  plugin({ id: 'terminal', title: 'Terminal', description: 'Open an interactive shell over the managed SSH connection.', kind: 'terminal', frontendModule: 'terminal', backendDriver: 'terminal', icon: 'terminal', integratedWindow: false, opensInteractiveTerminal: true, sandboxPolicy: 'iframe-terminal', capabilities: ['terminal', 'interactive-ssh'], permissions: ['ssh-session'], window: { width: 860, height: 480, maximized: true } }),
  plugin({ id: 'custom_terminal', title: 'Custom terminal shortcut', description: 'Run a browser-local custom shortcut command in a ShellOrchestra terminal session.', kind: 'terminal', frontendModule: 'terminal_profile', backendDriver: 'terminal', icon: 'terminal', integratedWindow: false, opensInteractiveTerminal: true, sandboxPolicy: 'iframe-terminal', capabilities: ['terminal-profile', 'custom-shortcuts'], permissions: ['ssh-session'], window: { width: 900, height: 560, maximized: true } }),
  plugin({ id: 'package_manager', dataRefreshIntervalSeconds: 30, title: 'Package Manager', description: 'Review installed packages and start install, remove, or upgrade operations with the detected package manager.', kind: 'package_manager', frontendModule: 'package_manager', backendDriver: 'script_data', icon: 'packages', integratedWindow: true, capabilities: ['packages', 'script-data', 'script-actions'], permissions: ['run-package-manager'], window: { width: 860, height: 390, maximized: true } }),
  plugin({ id: 'process_monitor', dataRefreshIntervalSeconds: 5, title: 'Task Manager', description: 'Inspect process details and request safe process termination through external ShellOrchestra script profiles.', kind: 'process_monitor', frontendModule: 'process_monitor', backendDriver: 'script_data', icon: 'processes', integratedWindow: true, capabilities: ['processes', 'script-data', 'script-actions'], permissions: ['inspect-processes', 'signal-processes'], window: { width: 640, height: 390, maximized: true } }),
  plugin({ id: 'file_manager', title: 'File Manager', description: 'Browse, preview, edit, copy, move, rename, and delete remote files through external ShellOrchestra script profiles.', kind: 'file_manager', frontendModule: 'file_manager', backendDriver: 'script_data', icon: 'files', integratedWindow: true, sandboxPolicy: 'sandboxed-preview', capabilities: ['files', 'stream-upload', 'stream-download', 'safe-preview'], permissions: ['read-files', 'write-files'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'document_viewer', title: 'Document Viewer', description: 'Open PDFs and office-style documents through a safe simplified preview pipeline.', kind: 'document_viewer', frontendModule: 'document_viewer', backendDriver: 'ui', icon: 'document', integratedWindow: true, sandboxPolicy: 'sandboxed-preview', capabilities: ['files', 'safe-preview', 'document-viewer'], permissions: ['read-files'], window: { width: 920, height: 600, maximized: true } }),
  plugin({ id: 'spreadsheet_viewer', title: 'Spreadsheet Viewer', description: 'Open spreadsheets through inert cell extraction and a safe grid preview.', kind: 'spreadsheet_viewer', frontendModule: 'spreadsheet_viewer', backendDriver: 'ui', icon: 'spreadsheet', integratedWindow: true, sandboxPolicy: 'sandboxed-preview', capabilities: ['files', 'safe-preview', 'spreadsheet-viewer'], permissions: ['read-files'], window: { width: 980, height: 620, maximized: true } }),
  plugin({ id: 'editor', title: 'Editor', description: 'Open remote text files in the sandboxed ShellOrchestra code editor.', kind: 'editor', frontendModule: 'editor', backendDriver: 'ui', icon: 'edit', integratedWindow: true, sandboxPolicy: 'sandboxed-editor', capabilities: ['code-editor', 'sandboxed-editor', 'safe-preview', 'stream-upload'], permissions: ['read-files', 'write-files'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'containers', dataRefreshIntervalSeconds: 5, title: 'Containers', description: 'Inspect and control Docker or Podman containers through explicit external script profiles.', kind: 'containers', frontendModule: 'containers', backendDriver: 'script_data', icon: 'docker', integratedWindow: true, capabilities: ['containers', 'script-data', 'script-actions'], permissions: ['inspect-containers', 'control-containers'], window: { width: 980, height: 600, maximized: true } }),
  plugin({ id: 'logs', dataRefreshIntervalSeconds: 10, title: 'Logs', description: 'Inspect system logs and service journal entries through bounded external script profiles.', kind: 'logs', frontendModule: 'logs', backendDriver: 'script_data', icon: 'logs', integratedWindow: true, capabilities: ['logs', 'journal', 'script-data', 'read-only'], permissions: ['inspect-logs'], window: { width: 920, height: 560, maximized: true } }),
  plugin({ id: 'services', dataRefreshIntervalSeconds: 10, title: 'Services', description: 'Inspect and control system services through external ShellOrchestra script profiles.', kind: 'services', frontendModule: 'services', backendDriver: 'script_data', icon: 'services', integratedWindow: true, capabilities: ['services', 'script-data', 'script-actions', 'open-editor'], permissions: ['control-services'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'ssh_server', dataRefreshIntervalSeconds: 30, title: 'SSH Server', description: 'Inspect and safely manage OpenSSH server policy, risky options, trusted user CAs, and Match blocks.', kind: 'ssh_server', frontendModule: 'ssh_server', backendDriver: 'script_data', icon: 'security', integratedWindow: true, capabilities: ['ssh-server', 'script-data', 'script-actions', 'safe-editor'], permissions: ['inspect-ssh-server', 'write-ssh-server'], window: { width: 920, height: 560, maximized: true } }),
  plugin({ id: 'network_connections', dataRefreshIntervalSeconds: 15, title: 'Network Connections', description: 'Inspect and explicitly configure common network settings through external ShellOrchestra script profiles.', kind: 'network_connections', frontendModule: 'network_connections', backendDriver: 'script_data', icon: 'network', integratedWindow: true, capabilities: ['network', 'script-data', 'script-actions'], permissions: ['inspect-network', 'configure-network'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'connection_watch', dataRefreshIntervalSeconds: 5, title: 'Connection Watch', description: 'Inspect TCP and UDP connections, including incoming, outgoing, and listening sockets.', kind: 'connection_watch', frontendModule: 'connection_watch', backendDriver: 'script_data', icon: 'connections', integratedWindow: true, capabilities: ['network', 'connections', 'script-data', 'read-only'], permissions: ['inspect-network'], window: { width: 920, height: 560, maximized: true } }),
  plugin({ id: 'custom_shortcuts', title: 'Custom Shortcuts', description: 'Create and manage browser-local terminal shortcuts that appear in the application launcher.', kind: 'custom_shortcuts', frontendModule: 'custom_shortcuts', backendDriver: 'ui', icon: 'terminal', integratedWindow: true, capabilities: ['custom-shortcuts', 'terminal-profile'], permissions: ['ssh-session'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'lan_watch', title: 'LAN Watch', description: 'Discover nearby LAN hosts and read SSH banners without authenticating.', kind: 'lan_watch', frontendModule: 'lan_watch', backendDriver: 'script_data', icon: 'lan_watch', integratedWindow: true, capabilities: ['network', 'lan-discovery', 'script-data', 'script-actions', 'read-only'], permissions: ['inspect-network', 'install-network-tools'], window: { width: 920, height: 560, maximized: true } }),
  plugin({ id: 'users', dataRefreshIntervalSeconds: 15, title: 'Users', description: 'Review local users and manage account passwords through external ShellOrchestra script profiles.', kind: 'users', frontendModule: 'users', backendDriver: 'script_data', icon: 'users', integratedWindow: true, capabilities: ['users', 'passwords', 'script-data', 'script-actions'], permissions: ['manage-users'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'cron_editor', title: 'Cron Editor', description: 'Review and edit user crontabs through external ShellOrchestra script profiles.', kind: 'cron_editor', frontendModule: 'cron_editor', backendDriver: 'script_data', icon: 'schedule', integratedWindow: true, capabilities: ['cron', 'script-data', 'script-actions'], permissions: ['read-crontab', 'write-crontab'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'sudo_editor', title: 'Edit Sudo', description: 'Review and edit sudoers files after target-side sudoers syntax validation.', kind: 'sudo_editor', frontendModule: 'sudo_editor', backendDriver: 'script_data', icon: 'security', integratedWindow: true, sandboxPolicy: 'sandboxed-editor', capabilities: ['sudoers', 'script-data', 'script-actions', 'safe-editor'], permissions: ['read-sudoers', 'write-sudoers'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'firewall', dataRefreshIntervalSeconds: 15, title: 'Firewall', description: 'Inspect and control supported firewall backends with SSH-access safety checks.', kind: 'firewall', frontendModule: 'firewall', backendDriver: 'script_data', icon: 'firewall', integratedWindow: true, capabilities: ['firewall', 'script-data', 'script-actions'], permissions: ['control-firewall'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'disks', title: 'Disks', description: 'Inspect disks, partitions, filesystems, and mount points in read-only mode through standard platform tools.', kind: 'disks', frontendModule: 'disks', backendDriver: 'script_data', icon: 'storage', integratedWindow: true, capabilities: ['disks', 'read-only', 'script-data'], permissions: ['inspect-disks'], window: { width: 860, height: 520, maximized: true } }),
  plugin({ id: 'pve_manager', dataRefreshIntervalSeconds: 5, dataMonitorIntervalSeconds: 5, dataMonitorTTLSeconds: 120, title: 'Virtual Machines', description: 'Inspect virtual machines and containers through virtualization providers. Current provider: Proxmox VE.', kind: 'pve_manager', frontendModule: 'pve_manager', backendDriver: 'script_data', icon: 'storage', integratedWindow: true, capabilities: ['virtual-machines', 'provider-proxmox', 'pve', 'script-data', 'script-actions'], permissions: ['inspect-pve', 'control-pve-guests'], window: { width: 920, height: 560, maximized: true } }),
  plugin({ id: 'speedtest', title: 'Test Speed', description: 'Measure multi-stream throughput between the ShellOrchestra backend server and a managed SSH server without installing a remote agent.', kind: 'speed_test', frontendModule: 'speed_test', backendDriver: 'speed_test', icon: 'speed', integratedWindow: true, capabilities: ['speed-test', 'streaming-telemetry'], permissions: ['network-test'], window: { width: 860, height: 390, maximized: true } }),
  plugin({ id: 'mc', title: 'Midnight Commander', description: 'Two-panel terminal file manager.', kind: 'terminal', frontendModule: 'terminal_profile', backendDriver: 'terminal', icon: 'files', integratedWindow: false, opensInteractiveTerminal: true, sandboxPolicy: 'iframe-terminal', capabilities: ['terminal-profile', 'fullscreen-tui'], permissions: ['ssh-session'], window: { width: 860, height: 480, maximized: true } }),
  plugin({ id: 'htop', title: 'htop', description: 'Interactive process monitor.', kind: 'terminal', frontendModule: 'terminal_profile', backendDriver: 'terminal', icon: 'processes', integratedWindow: false, opensInteractiveTerminal: true, sandboxPolicy: 'iframe-terminal', capabilities: ['terminal-profile', 'fullscreen-tui'], permissions: ['ssh-session'], window: { width: 860, height: 480, maximized: true } }),
  plugin({ id: 'btop', title: 'btop', description: 'Resource monitor with CPU, memory, disk, and network graphs.', kind: 'terminal', frontendModule: 'terminal_profile', backendDriver: 'terminal', icon: 'monitor', integratedWindow: false, opensInteractiveTerminal: true, sandboxPolicy: 'iframe-terminal', capabilities: ['terminal-profile', 'fullscreen-tui'], permissions: ['ssh-session'], window: { width: 860, height: 560, minWidth: 860, minHeight: 560, maximized: true } }),
  plugin({ id: 'neofetch', title: 'neofetch', description: 'Terminal system information summary.', kind: 'terminal', frontendModule: 'terminal_profile', backendDriver: 'terminal', icon: 'terminal', integratedWindow: false, opensInteractiveTerminal: true, sandboxPolicy: 'iframe-terminal', capabilities: ['terminal-profile'], permissions: ['ssh-session'], window: { width: 860, height: 480, maximized: true } }),
]);

export function normalizeDesktopAppModuleID(value: string): DesktopAppModuleID | null {
  const trimmed = value.trim();
  if (trimmed === 'terminal' || trimmed === 'terminal_profile' || trimmed === 'package_manager' || trimmed === 'process_monitor' || trimmed === 'file_manager' || trimmed === 'document_viewer' || trimmed === 'spreadsheet_viewer' || trimmed === 'editor' || trimmed === 'containers' || trimmed === 'logs' || trimmed === 'services' || trimmed === 'ssh_server' || trimmed === 'network_connections' || trimmed === 'connection_watch' || trimmed === 'custom_shortcuts' || trimmed === 'lan_watch' || trimmed === 'users' || trimmed === 'cron_editor' || trimmed === 'sudo_editor' || trimmed === 'firewall' || trimmed === 'disks' || trimmed === 'pve_manager' || trimmed === 'speed_test') return trimmed;
  return null;
}

export function normalizeDesktopWindowKind(value: string): DesktopWindowKind | null {
  const trimmed = value.trim();
  if (trimmed === 'terminal' || trimmed === 'package_manager' || trimmed === 'process_monitor' || trimmed === 'file_manager' || trimmed === 'document_viewer' || trimmed === 'spreadsheet_viewer' || trimmed === 'containers' || trimmed === 'logs' || trimmed === 'services' || trimmed === 'ssh_server' || trimmed === 'network_connections' || trimmed === 'connection_watch' || trimmed === 'custom_shortcuts' || trimmed === 'lan_watch' || trimmed === 'users' || trimmed === 'cron_editor' || trimmed === 'sudo_editor' || trimmed === 'firewall' || trimmed === 'disks' || trimmed === 'pve_manager' || trimmed === 'speed_test' || trimmed === 'editor') return trimmed;
  return null;
}

export function desktopAppWindowKind(app: DesktopApp): DesktopWindowKind {
  return normalizeDesktopWindowKind(app.kind) ?? desktopAppPlugins.module(app.frontend_module || '')?.kind ?? 'terminal';
}

export function desktopAppUsesIntegratedWindow(app: DesktopApp): boolean {
  if (typeof app.integrated_window === 'boolean') return app.integrated_window;
  const plugin = desktopAppPlugins.app(app.id) ?? desktopAppPlugins.module(app.frontend_module || app.kind || '');
  return plugin?.integratedWindow ?? false;
}

export function desktopAppRefreshIntervalMilliseconds(appOrWindow: { id?: string; app_id?: string; data_refresh_interval_seconds?: number; metadata?: Record<string, string> }, fallbackSeconds = 0): number {
  const fromMetadata = Number(appOrWindow.metadata?.data_refresh_interval_seconds || '');
  const fromAPI = Number(appOrWindow.data_refresh_interval_seconds || 0);
  const appID = (appOrWindow.app_id || appOrWindow.id || '').trim();
  const plugin = desktopAppPlugins.app(appID);
  const seconds = positiveSeconds(fromMetadata) || positiveSeconds(fromAPI) || positiveSeconds(plugin?.dataRefreshIntervalSeconds) || positiveSeconds(fallbackSeconds);
  return seconds > 0 ? seconds * 1000 : 0;
}

function positiveSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function desktopAppOpensInteractiveTerminal(app: DesktopApp): boolean {
  if (!app.installed || !app.supported) return false;
  const plugin = desktopAppPlugins.app(app.id) ?? desktopAppPlugins.module(app.frontend_module || app.kind || '');
  return plugin?.opensInteractiveTerminal ?? !desktopAppUsesIntegratedWindow(app);
}

function plugin(input: Omit<DesktopAppPluginDefinition, 'pluginID' | 'edition' | 'sandboxPolicy' | 'opensInteractiveTerminal' | 'dataRefreshIntervalSeconds' | 'dataMonitorIntervalSeconds' | 'dataMonitorTTLSeconds'> & Partial<Pick<DesktopAppPluginDefinition, 'pluginID' | 'edition' | 'sandboxPolicy' | 'opensInteractiveTerminal' | 'dataRefreshIntervalSeconds' | 'dataMonitorIntervalSeconds' | 'dataMonitorTTLSeconds'>>): DesktopAppPluginDefinition {
  return normalizePluginDefinition({ pluginID: 'builtin', edition: 'community', sandboxPolicy: 'main', opensInteractiveTerminal: false, dataRefreshIntervalSeconds: 0, dataMonitorIntervalSeconds: 0, dataMonitorTTLSeconds: 0, ...input });
}

function normalizePluginDefinition(definition: DesktopAppPluginDefinition): DesktopAppPluginDefinition {
  return {
    ...definition,
    id: definition.id.trim(),
    pluginID: definition.pluginID.trim() || 'builtin',
    title: definition.title.trim(),
    frontendModule: normalizeDesktopAppModuleID(definition.frontendModule) ?? definition.frontendModule,
    kind: normalizeDesktopWindowKind(definition.kind) ?? 'terminal',
    capabilities: definition.capabilities.map((item) => item.trim()).filter(Boolean),
    permissions: definition.permissions.map((item) => item.trim()).filter(Boolean),
    window: {
      width: Math.max(240, Math.round(definition.window.width)),
      height: Math.max(160, Math.round(definition.window.height)),
      minWidth: Math.max(240, Math.round(definition.window.minWidth ?? 360)),
      minHeight: Math.max(160, Math.round(definition.window.minHeight ?? 240)),
      maximized: definition.window.maximized,
    },
    dataRefreshIntervalSeconds: Math.max(0, Math.round(definition.dataRefreshIntervalSeconds || 0)),
    dataMonitorIntervalSeconds: Math.max(0, Math.round(definition.dataMonitorIntervalSeconds || 0)),
    dataMonitorTTLSeconds: Math.max(0, Math.round(definition.dataMonitorTTLSeconds || 0)),
  };
}
