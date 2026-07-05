// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import Box from '@mui/material/Box';
import type { EditorSandboxCommand } from '../desktop/apps/editor/EditorSandboxFrame';

const globalWithMonaco = globalThis as unknown as { MonacoEnvironment?: { getWorker: () => Worker } };
globalWithMonaco.MonacoEnvironment ??= { getWorker: () => new EditorWorker() };
loader.config({ monaco });

let editorSetupReady = false;
function ensureShellOrchestraEditorSetup() {
  if (editorSetupReady) return;
  registerShellOrchestraLanguages();
  monaco.editor.defineTheme('shellorchestra-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '7fb276', fontStyle: 'italic' },
      { token: 'string', foreground: 'ffba93' },
      { token: 'keyword', foreground: '86b7ff', fontStyle: 'bold' },
      { token: 'number', foreground: 'b5cea8' },
    ],
    colors: {
      'editor.background': '#0a1009',
      'editor.foreground': '#dee5d9',
      'editorCursor.foreground': '#00ff41',
      'editor.lineHighlightBackground': '#171d16',
      'editor.selectionBackground': '#00ff4138',
      'editorLineNumber.foreground': '#84967e',
      'editorLineNumber.activeForeground': '#ebffe2',
      'editorGutter.background': '#0f150e',
    },
  });
  editorSetupReady = true;
}

function registerShellOrchestraLanguages() {
  registerMonarchLanguage('shell', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*(if|then|else|elif|fi|for|while|do|done|case|esac|function|select|until)\b/, 'keyword'],
        [/\b(alias|builtin|cd|command|export|local|readonly|return|set|shift|source|test|trap|typeset|ulimit|umask|unset)\b/, 'keyword'],
        [/\b(apt|apt-get|apk|brew|curl|dnf|docker|find|grep|install|pacman|rsync|sed|ssh|sudo|systemctl|tar|wget|yum|zypper)\b/, 'type.identifier'],
        [/\$[{(]?[A-Za-z_][A-Za-z0-9_]*[})]?/, 'variable'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b\d+\b/, 'number'],
        [/[|&;(){}[\]]/, 'delimiter'],
      ],
    },
  });
  registerMonarchLanguage('ini', {
    tokenizer: {
      root: [
        [/^\s*[#;].*$/, 'comment'],
        [/^\s*\[[^\]]+\]/, 'keyword'],
        [/^\s*([A-Za-z0-9_.-]+)(\s*=\s*)/, ['attribute.name', 'delimiter']],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b(true|false|yes|no|on|off|enabled|disabled)\b/i, 'constant.language'],
        [/\b\d+(\.\d+)?\b/, 'number'],
      ],
    },
  });
  registerMonarchLanguage('toml', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*\[\[[^\]]+\]\]/, 'keyword'],
        [/^\s*\[[^\]]+\]/, 'keyword'],
        [/^\s*([A-Za-z0-9_.-]+)(\s*=\s*)/, ['attribute.name', 'delimiter']],
        [/"""(?:[^"]|"[^"]|""[^"])*"""/, 'string'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b(true|false)\b/, 'constant.language'],
        [/\b\d{4}-\d{2}-\d{2}([Tt ][0-9:.+-]+)?\b/, 'number'],
        [/\b[-+]?\d+(\.\d+)?\b/, 'number'],
        [/[{}\[\],]/, 'delimiter'],
      ],
    },
  });
  registerMonarchLanguage('systemd', {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*[#;].*$/, 'comment'],
        [/^\s*\[[^\]]+\]/, 'keyword'],
        [/^\s*([A-Za-z][\w.-]*)(=)/, ['attribute.name', 'delimiter']],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b(true|false|yes|no|on|off|always|never|restart|notify|forking|simple|oneshot)\b/, 'constant.language'],
        [/\b\d+(ms|s|min|h|d)?\b/, 'number'],
      ],
    },
  });
  registerMonarchLanguage('sudoers', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/\b(Defaults|User_Alias|Runas_Alias|Host_Alias|Cmnd_Alias)\b/, 'keyword'],
        [/\b(ALL|NOPASSWD|PASSWD|NOEXEC|SETENV|NOSETENV|LOG_INPUT|LOG_OUTPUT)\b/, 'constant.language'],
        [/%?[A-Za-z_][\w.-]*/, 'identifier'],
        [/[=,:()]/, 'delimiter'],
        [/\/[^\s,)]*/, 'string'],
      ],
    },
  });
  registerMonarchLanguage('crontab', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*[A-Za-z_][A-Za-z0-9_]*=.*/, 'attribute.name'],
        [/@(reboot|hourly|daily|weekly|monthly|yearly|annually)\b/, 'keyword'],
        [/(\*|\d+)([-/,](\*|\d+))*\b/, 'number'],
        [/\b(root|daemon|www-data|nobody)\b/, 'type.identifier'],
        [/\/[^\s]+/, 'string'],
      ],
    },
  });
  registerMonarchLanguage('passwd', {
    tokenizer: {
      root: [
        [/^[^:#\s]+/, 'attribute.name'],
        [/:/, 'delimiter'],
        [/\b\d+\b/, 'number'],
        [/\/[^\s:]*/, 'string'],
        [/^\s*#.*/, 'comment'],
      ],
    },
  });
  registerMonarchLanguage('sshconfig', {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*(Host|Match|Include)\b/, 'keyword'],
        [/^\s*(HostName|User|Port|IdentityFile|ProxyJump|ProxyCommand|ForwardAgent|PubkeyAuthentication|PasswordAuthentication|StrictHostKeyChecking|UserKnownHostsFile|GlobalKnownHostsFile|CertificateFile|HostKeyAlias|ServerAliveInterval|ServerAliveCountMax)\b/, 'attribute.name'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b(yes|no|ask|accept-new|none)\b/, 'constant.language'],
        [/\b\d+\b/, 'number'],
      ],
    },
  });
  registerMonarchLanguage('sshkeys', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*(cert-authority|principals=|command=|environment=|from=|no-[A-Za-z-]+|permit[A-Za-z-]+)(,|$)/, ['keyword', 'delimiter']],
        [/\b(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@[A-Za-z0-9_.-]+|sk-ecdsa-sha2-nistp\d+@[A-Za-z0-9_.-]+)\b/, 'type.identifier'],
        [/[A-Za-z0-9+/=]{24,}/, 'string'],
      ],
    },
  });
  registerMonarchLanguage('nginx', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/\b(events|http|server|location|upstream|map|if)\b/, 'keyword'],
        [/\b(listen|server_name|root|index|proxy_pass|include|access_log|error_log|ssl_certificate|ssl_certificate_key|return|rewrite|try_files)\b/, 'attribute.name'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/[{};]/, 'delimiter'],
        [/\b\d+[kmg]?\b/i, 'number'],
      ],
    },
  });
  registerMonarchLanguage('apache', {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/<\/?(VirtualHost|Directory|Location|IfModule|Files|FilesMatch|Proxy|RequireAll|RequireAny)[^>]*>/, 'keyword'],
        [/^\s*(ServerName|ServerAlias|DocumentRoot|Listen|LoadModule|Include|IncludeOptional|ErrorLog|CustomLog|ProxyPass|ProxyPassReverse|RewriteRule|RewriteCond|SSLEngine|SSLCertificateFile|SSLCertificateKeyFile)\b/, 'attribute.name'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/[<>/]/, 'delimiter'],
        [/\b\d+\b/, 'number'],
      ],
    },
  });
  registerMonarchLanguage('dotenv', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(=)/, ['keyword', 'attribute.name', 'delimiter']],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, 'variable'],
      ],
    },
  });
  registerMonarchLanguage('apt_sources', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*(deb|deb-src)\b/, 'keyword'],
        [/^\s*(Types|URIs|Suites|Components|Architectures|Signed-By|Enabled|Trusted|Check-Valid-Until)(:)/, ['attribute.name', 'delimiter']],
        [/\[[^\]]+\]/, 'annotation'],
        [/\b(http|https|file):\/\/[^\s]+/, 'string'],
        [/\b(main|contrib|non-free|non-free-firmware|universe|multiverse|restricted)\b/, 'constant.language'],
      ],
    },
  });
  registerMonarchLanguage('fstab', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*[^#\s]+/, 'string'],
        [/\b(ext[234]|xfs|btrfs|zfs|nfs|cifs|vfat|exfat|swap|auto|tmpfs|devpts|proc|sysfs)\b/, 'type.identifier'],
        [/\b(defaults|rw|ro|noatime|relatime|nofail|x-systemd\.automount|users?|exec|noexec|suid|nosuid|async|sync)\b/, 'keyword'],
        [/\b\d+\b/, 'number'],
      ],
    },
  });
  registerMonarchLanguage('hosts', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/(\b\d{1,3}(\.\d{1,3}){3}\b|\b[0-9a-f:]{3,}\b)/i, 'number'],
        [/\b[A-Za-z0-9_.-]+\b/, 'attribute.name'],
      ],
    },
  });
  registerMonarchLanguage('logrotate', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/\{|\}/, 'delimiter'],
        [/\b(daily|weekly|monthly|yearly|rotate|compress|delaycompress|missingok|notifempty|create|copytruncate|sharedscripts|postrotate|prerotate|firstaction|lastaction|endscript)\b/, 'keyword'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b\d+\b/, 'number'],
      ],
    },
  });
  registerMonarchLanguage('pam', {
    tokenizer: {
      root: [
        [/^\s*#.*/, 'comment'],
        [/^\s*(auth|account|password|session)\b/, 'keyword'],
        [/\b(required|requisite|sufficient|optional|include|substack)\b/, 'constant.language'],
        [/\[[^\]]+\]/, 'annotation'],
        [/\bpam_[A-Za-z0-9_]+\.so\b/, 'type.identifier'],
        [/[A-Za-z_][A-Za-z0-9_.-]*(=)/, ['attribute.name', 'delimiter']],
      ],
    },
  });
  registerMonarchLanguage('systemconfig', {
    tokenizer: {
      root: [
        [/^\s*[#;].*$/, 'comment'],
        [/^\s*\[[^\]]+\]/, 'keyword'],
        [/^\s*([A-Za-z0-9_.-]+)(\s*[=:]\s*)/, ['attribute.name', 'delimiter']],
        [/\b\d+(\.\d+){0,3}\b/, 'number'],
        [/\/[^\s:;#]+/, 'string'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
      ],
    },
  });
  registerMonarchLanguage('registry', {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*;.*/, 'comment'],
        [/^\s*Windows Registry Editor Version.*$/, 'keyword'],
        [/^\s*\[[^\]]+\]/, 'keyword'],
        [/^\s*("[^"]+"|@[A-Za-z0-9_.-]*)(=)/, ['attribute.name', 'delimiter']],
        [/"[^"]*"/, 'string'],
        [/\b(dword|hex|hex\(2\)|hex\(7\)):/, 'type.identifier'],
        [/\b[0-9a-f]{2}\b/, 'number'],
      ],
    },
  });
}

function registerMonarchLanguage(id: string, language: monaco.languages.IMonarchLanguage) {
  if (!monaco.languages.getLanguages().some((item) => item.id === id)) {
    monaco.languages.register({ id });
  }
  monaco.languages.setMonarchTokensProvider(id, language);
}

export function EditorFramePage() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const sessionIDRef = useRef('');
  const channelTokenRef = useRef('');
  const applyingRef = useRef(false);
  const [content, setContent] = useState('');
  const [language, setLanguage] = useState('plaintext');
  const [readOnly, setReadOnly] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [fontSize, setFontSize] = useState(13);

  useEffect(() => { ensureShellOrchestraEditorSetup(); }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<EditorSandboxCommand>) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'shellorchestra-editor:init') {
        sessionIDRef.current = data.session_id;
        channelTokenRef.current = data.channel_token;
        applyingRef.current = true;
        setContent(data.content || '');
        setLanguage(data.language || 'plaintext');
        setReadOnly(Boolean(data.read_only));
        setWrap(Boolean(data.wrap));
        setFontSize(Number.isFinite(data.font_size) ? data.font_size : 13);
        queueMicrotask(() => { applyingRef.current = false; });
        return;
      }
      if (data.type === 'shellorchestra-editor:find' && data.session_id === sessionIDRef.current && data.channel_token === channelTokenRef.current) {
        runWhitelistedEditorAction(editorRef.current, 'find');
        return;
      }
      if (data.type === 'shellorchestra-editor:run-action' && data.session_id === sessionIDRef.current && data.channel_token === channelTokenRef.current) {
        runWhitelistedEditorAction(editorRef.current, data.action_id);
        return;
      }
      if (data.type === 'shellorchestra-editor:focus' && data.session_id === sessionIDRef.current && data.channel_token === channelTokenRef.current) {
        editorRef.current?.focus();
      }
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'shellorchestra-editor:ready' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const onMount: OnMount = (instance) => {
    editorRef.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const sessionID = sessionIDRef.current;
      const channelToken = channelTokenRef.current;
      if (!sessionID || !channelToken) return;
      window.parent.postMessage({ type: 'shellorchestra-editor:save', session_id: sessionID, channel_token: channelToken }, '*');
    });
    instance.focus();
  };

  return (
    <Box sx={{ width: '100vw', height: '100vh', bgcolor: '#0a1009', overflow: 'hidden' }}>
      <Editor
        height="100vh"
        value={content}
        language={language}
        theme="shellorchestra-dark"
        onMount={onMount}
        onChange={(value) => {
          if (applyingRef.current || readOnly) return;
          const channelToken = channelTokenRef.current;
          if (!channelToken) return;
          const next = value ?? '';
          setContent(next);
          window.parent.postMessage({ type: 'shellorchestra-editor:changed', session_id: sessionIDRef.current, channel_token: channelToken, content: next }, '*');
        }}
        options={{
          readOnly,
          automaticLayout: true,
          fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize,
          lineHeight: Math.max(18, Math.round(fontSize * 1.55)),
          links: false,
          hover: { enabled: false },
          parameterHints: { enabled: false },
          quickSuggestions: false,
          suggestOnTriggerCharacters: false,
          acceptSuggestionOnCommitCharacter: false,
          acceptSuggestionOnEnter: 'off',
          codeLens: false,
          colorDecorators: false,
          contextmenu: false,
          minimap: { enabled: false },
          wordWrap: wrap ? 'on' : 'off',
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          tabSize: 2,
          insertSpaces: true,
          cursorStyle: 'line',
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          overviewRulerBorder: false,
          padding: { top: 8, bottom: 8 },
        }}
      />
    </Box>
  );
}

function runWhitelistedEditorAction(instance: editor.IStandaloneCodeEditor | null, actionID: string) {
  if (!instance) return;
  const normalized = actionID.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const monacoAction = editorActionMap[normalized];
  if (!monacoAction) return;
  const action = instance.getAction(monacoAction);
  if (action) {
    void action.run();
    return;
  }
  if (monacoCommandFallbacks.has(monacoAction)) {
    instance.trigger('shellorchestra-toolbar', monacoAction, null);
  }
}

const editorActionMap: Record<string, string> = {
  command_palette: 'editor.action.quickCommand',
  find: 'actions.find',
  go_to_line: 'editor.action.gotoLine',
  replace: 'editor.action.startFindReplaceAction',
  redo: 'redo',
  select_all: 'editor.action.selectAll',
  undo: 'undo',
};

const monacoCommandFallbacks = new Set(['redo', 'undo']);
