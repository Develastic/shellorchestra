// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useMemo, type ReactElement } from 'react';
import type { DesktopWindowSnapshot } from '../windowModel';
import { ConnectionWatchApp } from './connection-watch/ConnectionWatchApp';
import { ContainersApp } from './containers/ContainersApp';
import { CustomShortcutsApp } from './custom-shortcuts/CustomShortcutsApp';
import { CronEditorApp } from './cron-editor/CronEditorApp';
import { EditorApp } from './editor/EditorApp';
import { DisksApp } from './disks/DisksApp';
import { DocumentViewerApp } from './document-viewer/DocumentViewerApp';
import { FileManagerApp } from './file-manager/FileManagerApp';
import { FirewallApp } from './firewall/FirewallApp';
import { LanWatchApp } from './lan-watch/LanWatchApp';
import { LogsApp } from './logs/LogsApp';
import { NetworkConnectionsApp } from './network-connections/NetworkConnectionsApp';
import { PackageManagerApp } from './package-manager/PackageManagerApp';
import { desktopAppPlugins, normalizeDesktopAppModuleID, type DesktopAppPluginDefinition } from './pluginDefinitions';
import { createDesktopAppSandbox, DesktopAppContainer, DesktopAppSandboxBoundary, type DesktopAppSandbox, type OpenLogsWindowOptions } from './app-framework/sandbox';
import { ProcessMonitorApp } from './process-monitor/ProcessMonitorApp';
import { PVEManagerApp } from './pve-manager/PVEManagerApp';
import { ServicesApp } from './services/ServicesApp';
import { SSHServerApp } from './ssh-server/SSHServerApp';
import { SudoEditorApp } from './sudo-editor/SudoEditorApp';
import { UsersApp } from './users/UsersApp';
import { SpeedTestApp } from './speed-test/SpeedTestApp';
import { SpreadsheetViewerApp } from './spreadsheet-viewer/SpreadsheetViewerApp';
import type { DesktopWindowCloseGuard } from './closeGuard';
import type { DesktopAppModuleID, Server, ServerStatus } from './types';

export type DesktopAppRenderProps = {
  windowState: DesktopWindowSnapshot;
  server: Server;
  status?: ServerStatus;
  renderTerminalFrame: (sessionID: string) => ReactElement;
  openEditorWindow: (path: string, title?: string, options?: { mode?: 'editor' | 'log_viewer' }) => void;
  openLogsWindow: (path: string, title?: string, options?: OpenLogsWindowOptions) => void;
  openDocumentViewerWindow: (path: string, title?: string) => void;
  openSpreadsheetViewerWindow: (path: string, title?: string) => void;
  openTerminalApp: (appID: string, title: string, args?: Record<string, string>) => void;
  onWindowCloseGuardChange: (guard: DesktopWindowCloseGuard | null) => void;
  sandbox?: DesktopAppSandbox;
};

type DesktopAppModule = {
  id: DesktopAppModuleID;
  render: (props: DesktopAppRenderProps) => ReactElement;
};

const builtInApps: DesktopAppModule[] = [
  {
    id: 'terminal',
    render: (props) => {
      const { windowState, renderTerminalFrame } = props;
      if (!windowState.terminal_session_id) {
        return <Box sx={{ p: 1.5 }}><Alert severity="warning">This terminal window is missing its backend session. Close it and open a new terminal from the taskbar.</Alert></Box>;
      }
      props.sandbox?.requireCapability('terminal');
      return renderTerminalFrame(windowState.terminal_session_id);
    },
  },
  {
    id: 'terminal_profile',
    render: (props) => {
      const { windowState, renderTerminalFrame } = props;
      if (!windowState.terminal_session_id) {
        return <Box sx={{ p: 1.5 }}><Alert severity="warning">This terminal application window is missing its backend session. Close it and launch the app again.</Alert></Box>;
      }
      props.sandbox?.requireCapability('terminal-profile');
      return renderTerminalFrame(windowState.terminal_session_id);
    },
  },
  { id: 'package_manager', render: ({ server, status, windowState }) => <PackageManagerApp server={server} status={status} windowState={windowState} /> },
  { id: 'process_monitor', render: ({ server, status, windowState }) => <ProcessMonitorApp server={server} status={status} windowState={windowState} /> },
  { id: 'file_manager', render: ({ server, status }) => <FileManagerApp server={server} status={status} /> },
  { id: 'document_viewer', render: ({ server, status, windowState }) => <DocumentViewerApp server={server} status={status} windowState={windowState} /> },
  { id: 'spreadsheet_viewer', render: ({ server, status, windowState }) => <SpreadsheetViewerApp server={server} status={status} windowState={windowState} /> },
  { id: 'editor', render: ({ server, status, windowState, onWindowCloseGuardChange }) => <EditorApp server={server} status={status} windowState={windowState} onCloseGuardChange={onWindowCloseGuardChange} /> },
  { id: 'containers', render: ({ server, status, windowState }) => <ContainersApp server={server} status={status} windowState={windowState} /> },
  { id: 'logs', render: ({ server, status, windowState }) => <LogsApp server={server} status={status} windowState={windowState} /> },
  { id: 'services', render: ({ server, status, windowState }) => <ServicesApp server={server} status={status} windowState={windowState} /> },
  { id: 'ssh_server', render: ({ server, status, onWindowCloseGuardChange }) => <SSHServerApp server={server} status={status} onCloseGuardChange={onWindowCloseGuardChange} /> },
  { id: 'network_connections', render: ({ server, status, windowState }) => <NetworkConnectionsApp server={server} status={status} windowState={windowState} /> },
  { id: 'connection_watch', render: ({ server, status, windowState }) => <ConnectionWatchApp server={server} status={status} windowState={windowState} /> },
  { id: 'custom_shortcuts', render: ({ server, status, openTerminalApp }) => <CustomShortcutsApp server={server} status={status} openTerminalApp={openTerminalApp} /> },
  { id: 'lan_watch', render: ({ server, status }) => <LanWatchApp server={server} status={status} /> },
  { id: 'users', render: ({ server, status, windowState }) => <UsersApp server={server} status={status} windowState={windowState} /> },
  { id: 'cron_editor', render: ({ server, status, onWindowCloseGuardChange }) => <CronEditorApp server={server} status={status} onCloseGuardChange={onWindowCloseGuardChange} /> },
  { id: 'sudo_editor', render: ({ server, status, onWindowCloseGuardChange }) => <SudoEditorApp server={server} status={status} onCloseGuardChange={onWindowCloseGuardChange} /> },
  { id: 'firewall', render: ({ server, status, windowState }) => <FirewallApp server={server} status={status} windowState={windowState} /> },
  { id: 'disks', render: ({ server, status }) => <DisksApp server={server} status={status} /> },
  { id: 'pve_manager', render: ({ server, status, windowState, openTerminalApp }) => <PVEManagerApp server={server} status={status} windowState={windowState} openTerminalApp={openTerminalApp} /> },
  { id: 'speed_test', render: ({ server, status }) => <SpeedTestApp server={server} status={status} /> },
];

const builtInAppRegistry = new Map(builtInApps.map((app) => [app.id, app]));

export function DesktopAppContent(props: DesktopAppRenderProps) {
  const moduleID = normalizeDesktopAppModuleID(props.windowState.frontend_module || props.windowState.kind);
  const plugin = desktopAppPlugins.app(props.windowState.app_id) ?? desktopAppPlugins.module(moduleID || '');
  const app = moduleID ? builtInAppRegistry.get(moduleID) : undefined;
  if (!app) {
    return <PlaceholderApp title="Unsupported application" message={`No frontend plugin is registered for ${props.windowState.frontend_module || props.windowState.kind}.`} />;
  }
  if (!plugin) {
    return <PlaceholderApp title="Plugin contract mismatch" message={`Frontend module ${moduleID} exists, but no plugin contract registered it.`} />;
  }
  return <DesktopAppSandboxHost app={app} plugin={plugin} renderProps={props} />;
}

function DesktopAppSandboxHost({ app, plugin, renderProps }: { app: DesktopAppModule; plugin: DesktopAppPluginDefinition; renderProps: DesktopAppRenderProps }) {
  const sandbox = useMemo(
    () => createDesktopAppSandbox({ plugin, server: renderProps.server, windowState: renderProps.windowState, openEditorWindow: renderProps.openEditorWindow, openLogsWindow: renderProps.openLogsWindow, openDocumentViewerWindow: renderProps.openDocumentViewerWindow, openSpreadsheetViewerWindow: renderProps.openSpreadsheetViewerWindow }),
    [plugin, renderProps.openDocumentViewerWindow, renderProps.openEditorWindow, renderProps.openLogsWindow, renderProps.openSpreadsheetViewerWindow, renderProps.server.id, renderProps.windowState.id],
  );
  return (
    <DesktopAppContainer sandbox={sandbox}>
      <DesktopAppSandboxBoundary appID={sandbox.appID}>
        {app.render({ ...renderProps, sandbox })}
      </DesktopAppSandboxBoundary>
    </DesktopAppContainer>
  );
}

function PlaceholderApp({ title, message }: { title: string; message: string }) {
  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Typography variant="h6">{title}</Typography>
      <Typography color="text.secondary">{message}</Typography>
    </Stack>
  );
}
