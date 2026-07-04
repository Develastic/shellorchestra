// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { Component, createContext, forwardRef, useContext, type CSSProperties, type ErrorInfo, type IframeHTMLAttributes, type ReactEventHandler, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import { api, apiFetch } from '../../../api/client';
import type { components } from '../../../api/schema';
import type { DesktopWindowSnapshot } from '../../windowModel';
import type { DesktopAppBackendDriver, DesktopAppPluginDefinition, DesktopAppSandboxPolicy } from '../pluginDefinitions';
import type { Server } from '../types';
import { apiErrorMessage } from '../shared';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

type DesktopAppDataResponse = components['schemas']['DesktopAppDataResponse'];
type DesktopAppActionResponse = components['schemas']['DesktopAppActionResponse'];
type DesktopAppInstallResponse = components['schemas']['DesktopAppInstallResponse'];
type ScriptRun = components['schemas']['ScriptRun'];

export type DesktopAppCapability = string;
export type DesktopAppSandboxFetchOptions = RequestInit & { requiredCapability: DesktopAppCapability };
export type OpenLogsWindowOptions = {
  source?: 'file' | 'container';
  containerID?: string;
  containerEngine?: string;
  containerName?: string;
  tailLines?: number;
};

export class DesktopAppSandboxViolation extends Error {
  readonly appID: string;
  readonly capability: string;

  constructor(appID: string, capability: string) {
    super(`Desktop app ${appID} is not allowed to use ${capability}.`);
    this.name = 'DesktopAppSandboxViolation';
    this.appID = appID;
    this.capability = capability;
  }
}

export class DesktopAppCapabilitySet {
  private readonly values: ReadonlySet<string>;

  constructor(capabilities: readonly string[]) {
    this.values = new Set(capabilities.map((item) => normalizeCapability(item)).filter(Boolean));
  }

  has(capability: DesktopAppCapability): boolean {
    return this.values.has(normalizeCapability(capability));
  }

  require(appID: string, capability: DesktopAppCapability): void {
    if (!this.has(capability)) throw new DesktopAppSandboxViolation(appID, capability);
  }

  requireAny(appID: string, capabilities: readonly DesktopAppCapability[]): void {
    if (capabilities.some((capability) => this.has(capability))) return;
    throw new DesktopAppSandboxViolation(appID, capabilities.join(' or '));
  }

  list(): string[] {
    return Array.from(this.values).sort();
  }
}

export type DesktopAppSandboxConfig = {
  plugin: DesktopAppPluginDefinition;
  server: Server;
  windowState: DesktopWindowSnapshot;
  openEditorWindow: (path: string, title?: string, options?: { mode?: 'editor' | 'log_viewer' }) => void;
  openLogsWindow: (path: string, title?: string, options?: OpenLogsWindowOptions) => void;
  openDocumentViewerWindow: (path: string, title?: string) => void;
  openSpreadsheetViewerWindow: (path: string, title?: string) => void;
};

export class DesktopAppSandbox {
  readonly appID: string;
  readonly pluginID: string;
  readonly serverID: string;
  readonly windowID: string;
  readonly backendDriver: DesktopAppBackendDriver;
  readonly sandboxPolicy: DesktopAppSandboxPolicy;
  readonly capabilities: DesktopAppCapabilitySet;
  readonly permissions: DesktopAppCapabilitySet;
  private readonly openEditorWindowHandler: (path: string, title?: string, options?: { mode?: 'editor' | 'log_viewer' }) => void;
  private readonly openLogsWindowHandler: (path: string, title?: string, options?: OpenLogsWindowOptions) => void;
  private readonly openDocumentViewerWindowHandler: (path: string, title?: string) => void;
  private readonly openSpreadsheetViewerWindowHandler: (path: string, title?: string) => void;

  constructor(config: DesktopAppSandboxConfig) {
    this.appID = config.plugin.id;
    this.pluginID = config.plugin.pluginID;
    this.serverID = config.server.id;
    this.windowID = config.windowState.id;
    this.backendDriver = config.plugin.backendDriver;
    this.sandboxPolicy = config.plugin.sandboxPolicy;
    this.capabilities = new DesktopAppCapabilitySet(config.plugin.capabilities);
    this.permissions = new DesktopAppCapabilitySet(config.plugin.permissions);
    this.openEditorWindowHandler = config.openEditorWindow;
    this.openLogsWindowHandler = config.openLogsWindow;
    this.openDocumentViewerWindowHandler = config.openDocumentViewerWindow;
    this.openSpreadsheetViewerWindowHandler = config.openSpreadsheetViewerWindow;
  }

  hasCapability(capability: DesktopAppCapability): boolean {
    return this.capabilities.has(capability);
  }

  requireCapability(capability: DesktopAppCapability): void {
    this.capabilities.require(this.appID, capability);
  }

  requireAnyCapability(capabilities: readonly DesktopAppCapability[]): void {
    this.capabilities.requireAny(this.appID, capabilities);
  }

  assertServerID(serverID: string): void {
    if (serverID !== this.serverID) {
      throw new DesktopAppSandboxViolation(this.appID, `server ${serverID}`);
    }
  }

  async runData(args: Record<string, string>, requiredCapability: DesktopAppCapability, confirmed = false): Promise<DesktopAppDataResponse> {
    this.requireCapability(requiredCapability);
    if (this.backendDriver === 'script_data' && !confirmed) {
      return this.runDataStream(this.appID, args, requiredCapability);
    }
    const { data, error } = await api.POST('/desktop-apps/{appId}/data', {
      params: { path: { appId: this.appID } },
      body: { server_id: this.serverID, args, confirmed },
    });
    if (error || !data) throw new Error(apiErrorMessage(error) || `${this.appID} data could not be loaded.`);
    return data;
  }

  async runFileManagerData(args: Record<string, string>, requiredCapability: DesktopAppCapability, confirmed = false): Promise<DesktopAppDataResponse> {
    this.requireCapability(requiredCapability);
    if (!confirmed) {
      return this.runDataStream('file_manager', args, requiredCapability);
    }
    const { data, error } = await api.POST('/desktop-apps/{appId}/data', {
      params: { path: { appId: 'file_manager' } },
      body: { server_id: this.serverID, args, confirmed },
    });
    if (error || !data) throw new Error(apiErrorMessage(error) || 'File Manager data could not be loaded.');
    return data;
  }

  private async runDataStream(appID: string, args: Record<string, string>, requiredCapability: DesktopAppCapability): Promise<DesktopAppDataResponse> {
    this.requireCapability(requiredCapability);
    const response = await this.fetch(`/api/desktop-apps/${encodeURIComponent(appID)}/data-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args, confirmed: false }),
      requiredCapability,
    });
    if (!response.ok) throw new Error(await desktopAppStreamErrorMessage(response, `${appID} data could not be loaded.`));
    return readDesktopAppDataStream(response, appID);
  }

  async runAction(action: string, args: Record<string, string>, requiredCapability: DesktopAppCapability, confirmed: boolean): Promise<DesktopAppActionResponse> {
    this.requireCapability(requiredCapability);
    const { data, error } = await api.POST('/desktop-apps/{appId}/action', {
      params: { path: { appId: this.appID } },
      body: { server_id: this.serverID, action, args, confirmed },
    });
    if (error || !data) throw new Error(apiErrorMessage(error) || `${action} could not be started.`);
    return data;
  }

  async install(requiredCapability: DesktopAppCapability, confirmed: boolean): Promise<DesktopAppInstallResponse> {
    this.requireCapability(requiredCapability);
    const { data, error } = await api.POST('/desktop-apps/{appId}/install', {
      params: { path: { appId: this.appID } },
      body: { server_id: this.serverID, confirmed },
    });
    if (error || !data) throw new Error(apiErrorMessage(error) || `${this.appID} installation could not be started.`);
    return data;
  }

  async runStatus(runID: string, requiredCapability: DesktopAppCapability): Promise<ScriptRun> {
    this.requireCapability(requiredCapability);
    const { data, error } = await api.GET('/script-runs/{runId}', { params: { path: { runId: runID } } });
    if (error || !data) throw new Error(apiErrorMessage(error) || 'Script run status could not be loaded.');
    return data;
  }

  async fetch(input: string, init: DesktopAppSandboxFetchOptions): Promise<Response> {
    this.requireCapability(init.requiredCapability);
    const requestPath = sameOriginAPIPath(input);
    const { requiredCapability: _requiredCapability, ...requestInit } = init;
    return apiFetch(requestPath, requestInit);
  }

  openEditor(path: string, title?: string, options?: { mode?: 'editor' | 'log_viewer' }): void {
    this.requireAnyCapability(['files', 'code-editor', 'open-editor']);
    this.openEditorWindowHandler(path, title, options);
  }

  openLogs(path: string, title?: string): void {
    this.requireAnyCapability(['files', 'logs', 'open-logs']);
    this.openLogsWindowHandler(path, title);
  }

  openContainerLogs(input: { containerID: string; containerEngine?: string; containerName?: string; tailLines?: number }): void {
    this.requireAnyCapability(['containers', 'logs', 'open-logs']);
    const containerID = input.containerID.trim();
    const title = input.containerName?.trim() || containerID;
    this.openLogsWindowHandler('', title, {
      source: 'container',
      containerID,
      containerEngine: input.containerEngine?.trim() || 'auto',
      containerName: input.containerName?.trim() || containerID,
      tailLines: input.tailLines,
    });
  }

  openDocumentViewer(path: string, title?: string): void {
    this.requireAnyCapability(['files', 'safe-preview', 'document-viewer']);
    this.openDocumentViewerWindowHandler(path, title);
  }

  openSpreadsheetViewer(path: string, title?: string): void {
    this.requireAnyCapability(['files', 'safe-preview', 'spreadsheet-viewer']);
    this.openSpreadsheetViewerWindowHandler(path, title);
  }
}


export class DesktopAppSandboxBoundary extends Component<{ appID: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error('Desktop app sandbox boundary caught an error.', { appID: this.props.appID, error, info });
    }
  }

  componentDidUpdate(previousProps: { appID: string }): void {
    if (previousProps.appID !== this.props.appID && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <Box sx={{ p: 1.5 }}>
          <Alert severity="error" variant="outlined">
            {this.state.error instanceof DesktopAppSandboxViolation
              ? this.state.error.message
              : 'This desktop app stopped because its sandbox contract failed.'}
          </Alert>
        </Box>
      );
    }
    return this.props.children;
  }
}

const DesktopAppSandboxContext = createContext<DesktopAppSandbox | null>(null);

export function DesktopAppContainer({ sandbox, children }: { sandbox: DesktopAppSandbox; children: ReactNode }) {
  return (
    <DesktopAppSandboxContext.Provider value={sandbox}>
      <Box
        data-desktop-app-id={sandbox.appID}
        data-desktop-plugin-id={sandbox.pluginID}
        data-desktop-sandbox-policy={sandbox.sandboxPolicy}
        sx={{ height: '100%', minHeight: 0 }}
      >
        {children}
      </Box>
    </DesktopAppSandboxContext.Provider>
  );
}

export function useDesktopAppSandbox(requiredCapability?: DesktopAppCapability): DesktopAppSandbox {
  const sandbox = useContext(DesktopAppSandboxContext);
  if (!sandbox) throw new Error('Desktop app sandbox context is missing.');
  if (requiredCapability) sandbox.requireCapability(requiredCapability);
  return sandbox;
}

export function createDesktopAppSandbox(config: DesktopAppSandboxConfig): DesktopAppSandbox {
  return new DesktopAppSandbox(config);
}

export type SandboxIFrameProps = Omit<IframeHTMLAttributes<HTMLIFrameElement>, 'referrerPolicy' | 'sandbox' | 'src' | 'srcDoc' | 'title'> & {
  title: string;
  src?: string;
  srcDoc?: string;
  allowScripts?: boolean;
  testID?: string;
  onLoad?: ReactEventHandler<HTMLIFrameElement>;
  className?: string;
  style?: CSSProperties;
};

export const SandboxIFrame = forwardRef<HTMLIFrameElement, SandboxIFrameProps>(function SandboxIFrame(
  { title, src, srcDoc, allowScripts = false, testID, onLoad, className, style, ...frameProps },
  ref,
) {
  if (!src && !srcDoc) {
    return <Alert severity="error">Sandbox frame source is missing.</Alert>;
  }
  return (
    <iframe
      ref={ref}
      {...frameProps}
      title={title}
      src={src}
      srcDoc={srcDoc}
      sandbox={allowScripts ? 'allow-scripts' : ''}
      referrerPolicy="no-referrer"
      data-testid={testID}
      onLoad={onLoad}
      className={className}
      style={style}
    />
  );
});

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase();
}

function sameOriginAPIPath(input: string): string {
  const url = new URL(input, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
    throw new DesktopAppSandboxViolation('api', url.pathname || input);
  }
  return `${url.pathname}${url.search}`;
}

type DesktopAppDataStreamEvent = {
  event?: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
};

async function readDesktopAppDataStream(response: Response, appID: string): Promise<DesktopAppDataResponse> {
  let result: DesktopAppDataResponse | null = null;
  const errors: string[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result' && event.data && typeof event.data === 'object') {
        result = event.data as DesktopAppDataResponse;
      } else if (event.event === 'error') {
        errors.push(String(event.error || `${appID} data stream failed.`));
      }
    },
  });
  await client.readNDJSON();
  if (result) return result;
  if (errors.length > 0) throw new Error(errors.at(-1));
  throw new Error(`${appID} data stream finished without a result.`);
}

function parseDesktopAppDataStreamLine(line: string): DesktopAppDataStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as DesktopAppDataStreamEvent;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return { event: 'error', ok: false, error: 'Desktop app data stream returned invalid NDJSON.' };
  }
}

async function desktopAppStreamErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = (await response.text().catch(() => '')).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Plain text or NDJSON error body.
  }
  const firstLine = text.split('\n').find((line) => line.trim());
  if (firstLine) {
    const event = parseDesktopAppDataStreamLine(firstLine);
    if (event?.error) return event.error;
  }
  return text || fallback;
}
