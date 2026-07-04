// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import { SandboxIFrame } from '../app-framework/sandbox';

export type EditorSandboxCommand =
  | { type: 'shellorchestra-editor:init'; session_id: string; channel_token: string; content: string; language: string; read_only: boolean; wrap: boolean; font_size: number }
  | { type: 'shellorchestra-editor:focus'; session_id: string; channel_token: string }
  | { type: 'shellorchestra-editor:find'; session_id: string; channel_token: string }
  | { type: 'shellorchestra-editor:run-action'; session_id: string; channel_token: string; action_id: string }
  | { type: 'shellorchestra-editor:update-options'; session_id: string; channel_token: string; read_only: boolean; wrap: boolean; language: string; font_size: number };

export type EditorSandboxEvent =
  | { type: 'shellorchestra-editor:ready'; session_id?: string }
  | { type: 'shellorchestra-editor:changed'; session_id: string; channel_token: string; content: string }
  | { type: 'shellorchestra-editor:save'; session_id: string; channel_token: string }
  | { type: 'shellorchestra-editor:error'; session_id?: string; channel_token?: string; message: string };

type EditorSandboxFrameProps = {
  content: string;
  language: string;
  readOnly: boolean;
  wrap: boolean;
  fontSize?: number;
  onChange: (content: string) => void;
  onSaveShortcut?: () => void;
};

export type EditorSandboxHandle = {
  focus: () => void;
  find: () => void;
  runAction: (actionID: string) => void;
};

export const EditorSandboxFrame = forwardRef<EditorSandboxHandle, EditorSandboxFrameProps>(function EditorSandboxFrame(
  { content, language, readOnly, wrap, fontSize = 13, onChange, onSaveShortcut },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const latestContentRef = useRef(content);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const sessionID = useMemo(() => crypto.randomUUID(), []);
  const channelToken = useMemo(() => crypto.randomUUID(), []);

  useImperativeHandle(ref, () => ({
    focus: () => postCommand(iframeRef.current, { type: 'shellorchestra-editor:focus', session_id: sessionID, channel_token: channelToken }),
    find: () => postCommand(iframeRef.current, { type: 'shellorchestra-editor:find', session_id: sessionID, channel_token: channelToken }),
    runAction: (actionID: string) => postCommand(iframeRef.current, { type: 'shellorchestra-editor:run-action', session_id: sessionID, channel_token: channelToken, action_id: actionID }),
  }), [channelToken, sessionID]);

  useEffect(() => {
    latestContentRef.current = content;
  }, [content]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<EditorSandboxEvent>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'shellorchestra-editor:ready') {
        setReady(true);
        postCommand(iframeRef.current, { type: 'shellorchestra-editor:init', session_id: sessionID, channel_token: channelToken, content: latestContentRef.current, language, read_only: readOnly, wrap, font_size: fontSize });
        return;
      }
      if (data.type === 'shellorchestra-editor:changed' && data.session_id === sessionID && data.channel_token === channelToken) {
        onChange(data.content);
        return;
      }
      if (data.type === 'shellorchestra-editor:save' && data.session_id === sessionID && data.channel_token === channelToken) {
        onSaveShortcut?.();
        return;
      }
      if (data.type === 'shellorchestra-editor:error' && (!data.session_id || data.session_id === sessionID) && (!data.channel_token || data.channel_token === channelToken)) {
        setError(data.message || 'The sandboxed editor reported an error.');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [channelToken, fontSize, language, onChange, onSaveShortcut, readOnly, sessionID, wrap]);

  useEffect(() => {
    if (!ready) return;
    postCommand(iframeRef.current, { type: 'shellorchestra-editor:init', session_id: sessionID, channel_token: channelToken, content, language, read_only: readOnly, wrap, font_size: fontSize });
  }, [channelToken, content, fontSize, language, readOnly, ready, sessionID, wrap]);

  return (
    <Box sx={{ flex: 1, minHeight: 0, position: 'relative', border: '1px solid', borderColor: 'divider', bgcolor: '#0a1009' }}>
      {error && <Alert severity="error" sx={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 2 }} onClose={() => setError('')}>{error}</Alert>}
      <SandboxIFrame
        title="Sandboxed code editor"
        src="/editor-frame"
        allowScripts
        testID="editor-sandbox-frame"
        style={{ width: '100%', height: '100%', border: 0, display: 'block', background: '#0a1009' }}
        ref={iframeRef}
      />
    </Box>
  );
});

function postCommand(frame: HTMLIFrameElement | null, command: EditorSandboxCommand) {
  frame?.contentWindow?.postMessage(command, '*');
}
