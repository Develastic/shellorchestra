// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, MutableRefObject } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { defaultUISettings, type UISettings } from '../settings/uiSettings';
import { TerminalVirtualJoystick, TerminalVirtualKeyboard } from '../terminal/TerminalVirtualKeyboard';
import { normalizeTerminalKeymapLayout, type TerminalKeymapLayout } from '../terminal/keymapLayout';
import { terminalAltSequence, terminalCtrlSequence, terminalSpecialKeySequence, type TerminalSpecialKey } from '../terminal/terminalSequences';
import { monoFontFamily } from '../theme/theme';

export function TerminalFramePage() {
  const sessionID = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() ?? '');
  const frameConfig = terminalFrameConfig();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cursorOverlayRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingMessagesRef = useRef<TerminalStreamClientMessage[]>([]);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const streamRevisionRef = useRef(0);
  const inputBufferRef = useRef('');
  const inputFlushTimerRef = useRef<number | null>(null);
  const suppressNativePasteUntilRef = useRef(0);
  const fitFrameRef = useRef<number | null>(null);
  const fitTimersRef = useRef<number[]>([]);
  const resizeReconcileTimerRef = useRef<number | null>(null);
  const resizeInputHoldUntilRef = useRef(0);
  const resizeSuspendedRef = useRef(false);
  const desiredResizeRef = useRef<TerminalDesiredResize | null>(null);
  const streamErrorRef = useRef(false);
  const alternateScreenRef = useRef(false);
  const detectedMouseTrackingRef = useRef(false);
  const forcedMouseTrackingRef = useRef(frameConfig.mouseTracking);
  const mouseButtonsRef = useRef(0);
  const terminalSettingsRef = useRef<UISettings>(defaultUISettings);
  const commandHandlersRef = useRef<TerminalFrameCommandHandlers | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadFileHandlerRef = useRef<((file: File, shell: TerminalUploadShell) => void) | null>(null);
  const pendingUploadShellRef = useRef<TerminalUploadShell>('posix');
  const virtualKeyboardVisibleRef = useRef(false);
  const joystickVisibleRef = useRef(false);
  const [virtualKeyboardVisible, setVirtualKeyboardVisible] = useState(false);
  const [joystickVisible, setJoystickVisible] = useState(false);
  const [terminalUnavailable, setTerminalUnavailable] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [wallpaperURL, setWallpaperURL] = useState('');

  useEffect(() => {
    virtualKeyboardVisibleRef.current = virtualKeyboardVisible;
  }, [virtualKeyboardVisible]);

  useEffect(() => {
    joystickVisibleRef.current = joystickVisible;
  }, [joystickVisible]);

  useEffect(() => {
    if (!terminalUnavailable || !sessionID || window.parent === window) return;
    window.parent.postMessage({ type: 'shellorchestra-terminal-unavailable', sessionID, channel_token: frameConfig.channelToken }, frameConfig.parentOrigin || '*');
  }, [frameConfig.channelToken, frameConfig.parentOrigin, sessionID, terminalUnavailable]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== frameConfig.parentOrigin || !event.data || typeof event.data !== 'object') return;
      const payload = event.data as TerminalFrameParentCommand;
      if (payload.type !== 'shellorchestra-terminal-command') return;
      if (payload.sessionID && payload.sessionID !== sessionID) return;
      if (payload.channel_token !== frameConfig.channelToken) return;
      const handlers = commandHandlersRef.current;
      switch (payload.action) {
        case 'focus':
          handlers?.focus();
          break;
        case 'send-data':
          handlers?.sendData(typeof payload.data === 'string' ? payload.data : '');
          break;
        case 'send-key':
          handlers?.sendSpecialKey(payload.key ?? 'Escape');
          break;
        case 'paste':
          handlers?.paste(typeof payload.data === 'string' ? payload.data : '');
          break;
        case 'toggle-keyboard':
          setVirtualKeyboardVisible((value) => !value);
          break;
        case 'set-keyboard-visible':
          setVirtualKeyboardVisible(Boolean(payload.visible));
          break;
        case 'toggle-joystick':
          setJoystickVisible((value) => !value);
          break;
        case 'set-joystick-visible':
          setJoystickVisible(Boolean(payload.visible));
          break;
        case 'apply-settings':
          if (payload.settings) {
            applyTerminalSettings(terminalRef.current, fitRef.current, containerRef.current, payload.settings, terminalSettingsRef, socketRef, pendingMessagesRef, fitFrameRef, fitTimersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
          }
          break;
        case 'apply-background':
          setWallpaperURL(typeof payload.wallpaperURL === 'string' ? payload.wallpaperURL : '');
          break;
        case 'refit':
          if (terminalRef.current && fitRef.current) {
            scheduleTerminalFitBurst(terminalRef.current, fitRef.current, socketRef, pendingMessagesRef, fitFrameRef, fitTimersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
            scheduleTerminalRedrawBurst(socketRef, pendingMessagesRef, fitTimersRef, [360, 960, 1700, 2600]);
            scheduleTerminalRenderRefreshBurst(terminalRef.current, [520, 1200, 2100, 3000]);
          }
          break;
        case 'set-resize-suspended':
          resizeSuspendedRef.current = Boolean(payload.suspended);
          if (!resizeSuspendedRef.current && terminalRef.current && fitRef.current) {
            scheduleTerminalFitBurst(terminalRef.current, fitRef.current, socketRef, pendingMessagesRef, fitFrameRef, fitTimersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
          }
          break;
        case 'set-mouse-tracking':
          forcedMouseTrackingRef.current = Boolean(payload.enabled);
          break;
        case 'upload-file':
          handlers?.uploadFile(payload.shell === 'powershell' ? 'powershell' : 'posix');
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameConfig.channelToken, frameConfig.parentOrigin, sessionID]);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current || terminalUnavailable || !frameConfig.ready) return;
    let closed = false;
    const restoreDynamicStyleNonce = installDynamicStyleNonceForTerminalFrame();
    const terminalSettings = defaultUISettings;
    terminalSettingsRef.current = terminalSettings;
    const cursorStyle = effectiveTerminalCursorStyle(terminalSettings.terminal_cursor_style);
    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: false,
      convertEol: true,
      customGlyphs: true,
      disableStdin: false,
      fontFamily: monoFontFamily,
      fontSize: effectiveTerminalFontSize(terminalSettings),
      fontWeight: '400',
      fontWeightBold: '700',
      letterSpacing: 0,
      lineHeight: 1,
      scrollback: terminalSettings.terminal_scrollback_lines,
      cursorStyle,
      theme: {
        background: 'rgba(2, 6, 2, 0)',
        foreground: '#dee5d9',
        cursor: '#00ff41',
        cursorAccent: '#020602',
        selectionBackground: '#00ff4144',
        black: '#020602',
        brightBlack: '#596659',
        red: '#ffb4ab',
        brightRed: '#ffdad6',
        green: '#00ff41',
        brightGreen: '#72ff70',
        yellow: '#ffba43',
        brightYellow: '#ffddaf',
        blue: '#abc7ff',
        brightBlue: '#d7e2ff',
        cyan: '#b9ccb2',
        brightCyan: '#ebffe2',
        white: '#dee5d9',
        brightWhite: '#f9f9ff',
      },
    });
    const oscHandlerDisposables = [0, 1, 2, 8, 52].map((identifier) => terminal.parser.registerOscHandler(identifier, () => true));
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current);
    applyTouchKeyboardPolicy(containerRef.current, terminalSettings.terminal_suppress_touch_keyboard);
    scheduleTerminalFitBurst(terminal, fit, socketRef, pendingMessagesRef, fitFrameRef, fitTimersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
    void waitForTerminalFonts().then(() => {
      if (!closed) {
        scheduleTerminalFitBurst(terminal, fit, socketRef, pendingMessagesRef, fitFrameRef, fitTimersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
        refreshTerminalRender(terminal);
        updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current);
      }
    });
    const focusTerminalNow = () => {
      terminal.focus();
      refreshTerminalRender(terminal);
      scheduleTerminalRenderRefreshBurst(terminal, [40, 140, 360]);
      updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current);
      window.requestAnimationFrame(() => updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current));
      window.setTimeout(() => updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current), 50);
    };
    focusTerminalNow();
    const flushTerminalInput = () => {
      inputFlushTimerRef.current = null;
      if (!inputBufferRef.current) return;
      const resizeHoldMs = resizeInputHoldUntilRef.current - performance.now();
      if (resizeHoldMs > 0) {
        inputFlushTimerRef.current = window.setTimeout(flushTerminalInput, Math.min(Math.ceil(resizeHoldMs) + 15, 1200));
        return;
      }
      const terminalInput = inputBufferRef.current;
      inputBufferRef.current = '';
      if (!terminalInput) return;
      sendTerminalStreamMessage(socketRef.current, { type: 'input', data: terminalInput }, pendingMessagesRef.current, () => setErrorMessage('Terminal stream is not connected. Use Retry to open a fresh stream.'));
    };
    const sendTerminalPaste = (text: string) => {
      if (!text) return;
      sendTerminalStreamMessage(socketRef.current, { type: 'paste', data: text }, pendingMessagesRef.current, () => setErrorMessage('Terminal stream is not connected. Use Retry to open a fresh stream.'));
      focusTerminalNow();
    };
    const copySelection = async () => {
      const selection = terminal.getSelection();
      if (!selection || !navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(selection);
      terminal.clearSelection();
      focusTerminalNow();
      return true;
    };
    const terminalDebugWindow = window as ShellOrchestraTerminalDebugWindow;
    const terminalInputTrace: TerminalInputTraceEntry[] = [];
    terminalDebugWindow.shellorchestraTerminalInputTrace = terminalInputTrace;
    terminalDebugWindow.shellorchestraTerminalReadInputTrace = () => terminalInputTrace.slice();
    terminalDebugWindow.shellorchestraTerminalClearInputTrace = () => {
      terminalInputTrace.splice(0);
    };
    const pasteClipboard = async () => {
      if (!navigator.clipboard?.readText) {
        setErrorMessage('Clipboard text paste is not available in this browser context.');
        return;
      }
      suppressNativePasteUntilRef.current = performance.now() + 1000;
      const text = await navigator.clipboard.readText();
      sendTerminalPaste(text);
    };
    const uploadLocalFile = async (file: File, shell: TerminalUploadShell) => {
      try {
        const command = await buildTerminalUploadCommand(file, shell);
        sendTerminalPaste(command);
        setErrorMessage('');
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'ShellOrchestra could not prepare the upload command.');
      }
    };
    uploadFileHandlerRef.current = (file, shell) => {
      void uploadLocalFile(file, shell);
    };
    const queueTerminalInput = (data: string) => {
      recordTerminalInputTrace(terminalInputTrace, data);
      inputBufferRef.current += data;
      if (inputFlushTimerRef.current !== null) {
        window.clearTimeout(inputFlushTimerRef.current);
      }
      inputFlushTimerRef.current = window.setTimeout(flushTerminalInput, 25);
    };
    commandHandlersRef.current = {
      focus: focusTerminalNow,
      paste: sendTerminalPaste,
      sendData: (data: string) => {
        if (!data) return;
        queueTerminalInput(data);
        focusTerminalNow();
      },
      sendSpecialKey: (key: TerminalSpecialKey) => {
        const sequence = terminalSpecialKeySequence(key);
        if (!sequence) return;
        queueTerminalInput(sequence);
        focusTerminalNow();
      },
      uploadFile: (shell: TerminalUploadShell) => {
        pendingUploadShellRef.current = shell;
        uploadInputRef.current?.click();
        focusTerminalNow();
      },
    };
    const inputDisposable = terminal.onData((data) => {
      const mappedData = mapXtermData(data, normalizeTerminalKeymapLayout(terminalSettingsRef.current.terminal_keymap_layout));
      if (isTerminalDeviceResponse(mappedData)) {
        flushTerminalInput();
        return;
      }
      queueTerminalInput(mappedData);
    });
    const renderDisposable = terminal.onRender(() => {
      updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current);
    });
    const cursorDisposable = terminal.onCursorMove(() => {
      updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current);
    });
    const writeParsedDisposable = terminal.onWriteParsed(() => {
      updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current);
    });
    const cursorFocusListener = () => {
      updateTerminalCursorOverlay(terminal, containerRef.current, cursorOverlayRef.current);
    };
    const preventTerminalShortcutDefault = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      terminal.focus();
    };
    const browserShortcutGuard = (event: KeyboardEvent) => {
      if (terminalKeyboardEventBelongsToTerminal(event)) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', browserShortcutGuard, { capture: true });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyC' && terminal.hasSelection()) {
        preventTerminalShortcutDefault(event);
        void copySelection();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyC') {
        preventTerminalShortcutDefault(event);
        void copySelection();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === 'Insert') {
        preventTerminalShortcutDefault(event);
        void copySelection();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyV') {
        preventTerminalShortcutDefault(event);
        void pasteClipboard();
        return false;
      }
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Insert') {
        preventTerminalShortcutDefault(event);
        void pasteClipboard();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyV') {
        preventTerminalShortcutDefault(event);
        void pasteClipboard();
        return false;
      }
      if (terminalSettingsRef.current.terminal_tmux_prefix_guard && isShellOrchestraReservedTmuxPrefix(event)) {
        preventTerminalShortcutDefault(event);
        return false;
      }
      const keySequence = terminalKeyboardEventSequence(event);
      if (keySequence) {
        preventTerminalShortcutDefault(event);
        queueTerminalInput(keySequence);
        return false;
      }
      return true;
    });
    const pasteListener = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      if (performance.now() < suppressNativePasteUntilRef.current) return;
      sendTerminalPaste(text);
    };
    const contextMenuPasteListener = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void pasteClipboard();
    };
    const terminalMouseDownListener = (event: MouseEvent) => {
      if (!terminalMouseTrackingEnabled(alternateScreenRef, forcedMouseTrackingRef, detectedMouseTrackingRef)) return;
      if (terminalRightClickReservedForPaste(event)) return;
      const code = terminalMouseButtonCode(event);
      if (code === null) return;
      event.preventDefault();
      event.stopPropagation();
      mouseButtonsRef.current = event.buttons;
      terminal.focus();
      queueTerminalInput(terminalMouseSequence(terminal, event, code + terminalMouseModifierCode(event), true));
    };
    const terminalMouseUpListener = (event: MouseEvent) => {
      if (!terminalMouseTrackingEnabled(alternateScreenRef, forcedMouseTrackingRef, detectedMouseTrackingRef)) return;
      if (terminalRightClickReservedForPaste(event)) return;
      const code = terminalMouseButtonCode(event);
      if (code === null) return;
      event.preventDefault();
      event.stopPropagation();
      terminal.focus();
      queueTerminalInput(terminalMouseSequence(terminal, event, code + terminalMouseModifierCode(event), false));
      mouseButtonsRef.current = event.buttons;
    };
    const terminalMouseMoveListener = (event: MouseEvent) => {
      if (!terminalMouseTrackingEnabled(alternateScreenRef, forcedMouseTrackingRef, detectedMouseTrackingRef) || mouseButtonsRef.current === 0) return;
      const code = terminalMouseMotionButtonCode(event.buttons);
      if (code === null) return;
      event.preventDefault();
      event.stopPropagation();
      queueTerminalInput(terminalMouseSequence(terminal, event, code + 32 + terminalMouseModifierCode(event), true));
    };
    const terminalWheelListener = (event: WheelEvent) => {
      if (!terminalMouseTrackingEnabled(alternateScreenRef, forcedMouseTrackingRef, detectedMouseTrackingRef)) return;
      event.preventDefault();
      event.stopPropagation();
      terminal.focus();
      queueTerminalInput(terminalMouseSequence(terminal, event, (event.deltaY < 0 ? 64 : 65) + terminalMouseModifierCode(event), true));
    };
    containerRef.current.addEventListener('paste', pasteListener, { capture: true });
    containerRef.current.addEventListener('contextmenu', contextMenuPasteListener, { capture: true });
    containerRef.current.addEventListener('focusin', cursorFocusListener, { capture: true });
    containerRef.current.addEventListener('focusout', cursorFocusListener, { capture: true });
    containerRef.current.addEventListener('mousedown', terminalMouseDownListener, { capture: true });
    containerRef.current.addEventListener('mouseup', terminalMouseUpListener, { capture: true });
    containerRef.current.addEventListener('mousemove', terminalMouseMoveListener, { capture: true });
    containerRef.current.addEventListener('wheel', terminalWheelListener, { capture: true });
    terminalRef.current = terminal;
    fitRef.current = fit;
    const terminalInstanceID = crypto.randomUUID();
    terminalDebugWindow.shellorchestraTerminal = terminal;
    terminalDebugWindow.shellorchestraTerminalInstanceID = terminalInstanceID;
    terminalDebugWindow.shellorchestraTerminalVisibleText = () => terminalVisibleBufferText(terminal);
    terminalDebugWindow.shellorchestraTerminalDebug = () => ({
      alternateScreen: alternateScreenRef.current,
      cols: terminal.cols,
      cursorStyle: terminal.options.cursorStyle,
      cursorX: terminal.buffer.active.cursorX,
      cursorY: terminal.buffer.active.cursorY,
      forcedMouseTracking: forcedMouseTrackingRef.current,
      instanceID: terminalInstanceID,
      joystickVisible: joystickVisibleRef.current,
      keyboardVisible: virtualKeyboardVisibleRef.current,
      mouseTracking: terminalMouseTrackingEnabled(alternateScreenRef, forcedMouseTrackingRef, detectedMouseTrackingRef),
      rows: terminal.rows,
      sessionID,
      visibleText: terminalVisibleBufferText(terminal),
    });
    const openTerminalStream = async () => {
      const socket = new WebSocket(terminalStreamURL(sessionID, frameConfig.ticket));
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onopen = () => {
        setErrorMessage('');
        const pendingMessages = pendingMessagesRef.current.splice(0).filter((message) => message.type !== 'resize');
        for (const message of pendingMessages) {
          sendTerminalStreamMessage(socket, message);
        }
        try {
          fit.fit();
        } catch {
          // The scheduled fit burst below will retry after the iframe layout settles.
        }
        sendTerminalResize(socket, terminal.cols, terminal.rows, pendingMessagesRef.current, desiredResizeRef);
        scheduleTerminalResizeReconcile(socketRef, pendingMessagesRef, resizeReconcileTimerRef, resizeInputHoldUntilRef);
        scheduleTerminalFitBurst(terminal, fit, socketRef, pendingMessagesRef, fitFrameRef, fitTimersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
        scheduleTerminalRedrawBurst(socketRef, pendingMessagesRef, fitTimersRef, [260, 900, 1800]);
        scheduleTerminalRenderRefreshBurst(terminal, [320, 760, 1500]);
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          handleTerminalStreamText(terminal, event.data, setErrorMessage, setTerminalUnavailable, streamErrorRef, writeQueueRef, streamRevisionRef, socketRef, pendingMessagesRef, desiredResizeRef, alternateScreenRef, detectedMouseTrackingRef);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          setErrorMessage('Terminal stream returned an unsupported binary payload.');
          return;
        }
        if (event.data instanceof Blob) {
          setErrorMessage('Terminal stream returned an unsupported binary payload.');
        }
      };
      socket.onerror = () => {
        streamErrorRef.current = true;
        if (!closed) setErrorMessage('Terminal stream connection failed.');
      };
      socket.onclose = () => {
        if (!closed && !streamErrorRef.current) setErrorMessage('Terminal stream disconnected. Use Retry to open a fresh stream.');
      };
    };
    void openTerminalStream();
    const resizeObserver = new ResizeObserver(() => {
      scheduleTerminalFitBurst(terminal, fit, socketRef, pendingMessagesRef, fitFrameRef, fitTimersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
      scheduleTerminalRedrawBurst(socketRef, pendingMessagesRef, fitTimersRef, [360, 960, 1700, 2600]);
      scheduleTerminalRenderRefreshBurst(terminal, [520, 1200, 2100, 3000]);
    });
    const windowResizeListener = () => {
      if (terminalSettingsRef.current) {
        terminal.options.fontSize = effectiveTerminalFontSize(terminalSettingsRef.current);
      }
      scheduleTerminalFitBurst(terminal, fit, socketRef, pendingMessagesRef, fitFrameRef, fitTimersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
      scheduleTerminalRedrawBurst(socketRef, pendingMessagesRef, fitTimersRef, [360, 960, 1700, 2600]);
      scheduleTerminalRenderRefreshBurst(terminal, [520, 1200, 2100, 3000]);
    };
    resizeObserver.observe(containerRef.current);
    window.addEventListener('resize', windowResizeListener);
    return () => {
      closed = true;
      if (inputFlushTimerRef.current !== null) {
        window.clearTimeout(inputFlushTimerRef.current);
        inputFlushTimerRef.current = null;
      }
      socketRef.current?.close();
      socketRef.current = null;
      streamErrorRef.current = false;
      alternateScreenRef.current = false;
      detectedMouseTrackingRef.current = false;
      forcedMouseTrackingRef.current = false;
      mouseButtonsRef.current = 0;
      streamRevisionRef.current = 0;
      pendingMessagesRef.current = [];
      writeQueueRef.current = Promise.resolve();
      commandHandlersRef.current = null;
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      for (const timer of fitTimersRef.current) {
        window.clearTimeout(timer);
      }
      fitTimersRef.current = [];
      if (resizeReconcileTimerRef.current !== null) {
        window.clearTimeout(resizeReconcileTimerRef.current);
        resizeReconcileTimerRef.current = null;
      }
      resizeInputHoldUntilRef.current = 0;
      resizeObserver.disconnect();
      window.removeEventListener('resize', windowResizeListener);
      window.removeEventListener('keydown', browserShortcutGuard, { capture: true });
      containerRef.current?.removeEventListener('paste', pasteListener, { capture: true });
      containerRef.current?.removeEventListener('contextmenu', contextMenuPasteListener, { capture: true });
      containerRef.current?.removeEventListener('focusin', cursorFocusListener, { capture: true });
      containerRef.current?.removeEventListener('focusout', cursorFocusListener, { capture: true });
      containerRef.current?.removeEventListener('mousedown', terminalMouseDownListener, { capture: true });
      containerRef.current?.removeEventListener('mouseup', terminalMouseUpListener, { capture: true });
      containerRef.current?.removeEventListener('mousemove', terminalMouseMoveListener, { capture: true });
      containerRef.current?.removeEventListener('wheel', terminalWheelListener, { capture: true });
      inputDisposable.dispose();
      renderDisposable.dispose();
      cursorDisposable.dispose();
      writeParsedDisposable.dispose();
      for (const disposable of oscHandlerDisposables) {
        disposable.dispose();
      }
      terminal.dispose();
      restoreDynamicStyleNonce();
      if (terminalDebugWindow.shellorchestraTerminal) {
        delete terminalDebugWindow.shellorchestraTerminal;
      }
      if (terminalDebugWindow.shellorchestraTerminalVisibleText) {
        delete terminalDebugWindow.shellorchestraTerminalVisibleText;
      }
      if (terminalDebugWindow.shellorchestraTerminalDebug) {
        delete terminalDebugWindow.shellorchestraTerminalDebug;
      }
      if (terminalDebugWindow.shellorchestraTerminalInstanceID) {
        delete terminalDebugWindow.shellorchestraTerminalInstanceID;
      }
      if (terminalDebugWindow.shellorchestraTerminalInputTrace) {
        delete terminalDebugWindow.shellorchestraTerminalInputTrace;
      }
      if (terminalDebugWindow.shellorchestraTerminalReadInputTrace) {
        delete terminalDebugWindow.shellorchestraTerminalReadInputTrace;
      }
      if (terminalDebugWindow.shellorchestraTerminalClearInputTrace) {
        delete terminalDebugWindow.shellorchestraTerminalClearInputTrace;
      }
      uploadFileHandlerRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [frameConfig.ready, frameConfig.ticket, sessionID, terminalUnavailable]);

  if (!sessionID) {
    return <TerminalFrameMessage severity="error" title="Terminal session is missing" message="ShellOrchestra could not identify which terminal session should be displayed." />;
  }

  if (!frameConfig.ready) {
    return <TerminalFrameMessage severity="error" title="Protected terminal stream is missing" message="ShellOrchestra could not open this terminal because its short-lived stream ticket is missing. Close this terminal window and open a new one from the virtual desktop taskbar." />;
  }

  if (terminalUnavailable) {
    return (
      <TerminalFrameMessage
        severity="warning"
        title="Terminal session is no longer available"
        message="This terminal belonged to an older backend runtime. Close this window and open a new terminal from the virtual desktop taskbar."
      />
    );
  }

  const frameBackground = terminalFrameBackground(wallpaperURL);

  const onUploadInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const handler = uploadFileHandlerRef.current;
    if (!handler) {
      setErrorMessage('Terminal is not ready for file upload yet. Wait until the prompt appears, then try again.');
      return;
    }
    handler(file, pendingUploadShellRef.current);
  };

  return (
    <Box
      data-testid="terminal-frame-root"
      onPointerDownCapture={() => terminalRef.current?.focus()}
      sx={{
        height: '100vh',
        width: '100vw',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: '#020602',
        background: frameBackground,
        overflow: 'hidden',
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          opacity: 0.22,
          backgroundImage: 'linear-gradient(rgba(222,229,217,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(222,229,217,0.04) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          pointerEvents: 'none',
        },
        '& > *': {
          position: 'relative',
          zIndex: 1,
        },
      }}
    >
      {errorMessage && <Alert severity="error" onClose={() => setErrorMessage('')} sx={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 2 }}>{errorMessage}</Alert>}
      <input ref={uploadInputRef} type="file" hidden onChange={onUploadInputChange} />
      <Box
        ref={containerRef}
        sx={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          width: '100%',
          '& .xterm': { background: 'transparent !important', height: '100%', width: '100%' },
          '& .xterm .xterm-viewport, & .xterm .xterm-screen': { background: 'transparent !important', minWidth: '100%' },
          '& .xterm-viewport': { overflowY: 'auto' },
          '& .xterm-helper-textarea': { caretColor: 'transparent', pointerEvents: 'none' },
          '& .xterm .xterm-cursor': {
            opacity: '0 !important',
            visibility: 'hidden !important',
          },
        }}
      >
        <Box
          ref={cursorOverlayRef}
          aria-hidden="true"
          data-testid="terminal-cursor"
          sx={{
            position: 'absolute',
            left: 0,
            top: 0,
            zIndex: 3,
            height: 4,
            borderRadius: 1,
            bgcolor: '#00ff41',
            boxShadow: '0 0 10px rgba(0,255,65,0.82)',
            pointerEvents: 'none',
            opacity: 0,
            transform: 'translate3d(0, 0, 0)',
            transition: 'opacity 120ms ease-out',
          }}
        />
        <TerminalVirtualJoystick
          visible={joystickVisible}
          onInput={(data) => commandHandlersRef.current?.sendData(data)}
        />
      </Box>
      <TerminalVirtualKeyboard
        visible={virtualKeyboardVisible}
        onInput={(data) => commandHandlersRef.current?.sendData(data)}
      />
    </Box>
  );
}

function effectiveTerminalCursorStyle(style: UISettings['terminal_cursor_style'] | undefined): Terminal['options']['cursorStyle'] {
  return style === 'bar' ? 'bar' : 'underline';
}

function installDynamicStyleNonceForTerminalFrame(): () => void {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="shellorchestra-csp-nonce"]')?.content.trim();
  if (!nonce) return () => undefined;
  const documentWithCreateElement = document as Document & { createElement: Document['createElement'] };
  const originalCreateElement = documentWithCreateElement.createElement;
  const patchedCreateElement = function patchedCreateElement(this: Document, tagName: string, options?: ElementCreationOptions) {
    const element = originalCreateElement.call(this, tagName, options);
    if (String(tagName).toLowerCase() === 'style') {
      // xterm creates runtime style tags for renderer metrics; attach the response nonce before those tags enter the DOM.
      element.setAttribute('nonce', nonce);
    }
    return element;
  } as Document['createElement'];
  documentWithCreateElement.createElement = patchedCreateElement;
  return () => {
    if (documentWithCreateElement.createElement === patchedCreateElement) {
      documentWithCreateElement.createElement = originalCreateElement;
    }
  };
}

function effectiveTerminalFontSize(settings: UISettings): number {
  const configured = Number.isFinite(settings.terminal_font_size) ? settings.terminal_font_size : defaultUISettings.terminal_font_size;
  if (terminalViewportIsPhoneSized()) {
    return Math.max(8, Math.min(configured, 8));
  }
  if (terminalViewportIsSmallTablet()) {
    return Math.max(8, Math.min(configured, 11));
  }
  return configured;
}

function terminalViewportIsPhoneSized(): boolean {
  return window.matchMedia?.('(max-width: 600px)').matches ?? window.innerWidth <= 600;
}

function terminalViewportIsSmallTablet(): boolean {
  return window.matchMedia?.('(max-width: 900px)').matches ?? window.innerWidth <= 900;
}

type TerminalFrameCommandHandlers = {
  focus: () => void;
  paste: (text: string) => void;
  sendData: (data: string) => void;
  sendSpecialKey: (key: TerminalSpecialKey) => void;
  uploadFile: (shell: TerminalUploadShell) => void;
};

type TerminalUploadShell = 'posix' | 'powershell';

type TerminalInputTraceEntry = {
  codes: number[];
  data: string;
  hex: string[];
};

type ShellOrchestraTerminalDebugWindow = Window & {
  shellorchestraTerminal?: Terminal;
  shellorchestraTerminalClearInputTrace?: () => void;
  shellorchestraTerminalDebug?: () => { alternateScreen: boolean; cols: number; cursorStyle: string | undefined; cursorX: number; cursorY: number; forcedMouseTracking: boolean; instanceID: string; joystickVisible: boolean; keyboardVisible: boolean; mouseTracking: boolean; rows: number; sessionID: string; visibleText: string };
  shellorchestraTerminalInputTrace?: TerminalInputTraceEntry[];
  shellorchestraTerminalInstanceID?: string;
  shellorchestraTerminalReadInputTrace?: () => TerminalInputTraceEntry[];
  shellorchestraTerminalVisibleText?: () => string;
};

function recordTerminalInputTrace(trace: TerminalInputTraceEntry[], data: string) {
  if (!data) return;
  trace.push({
    data,
    codes: Array.from(data, (char) => char.charCodeAt(0)),
    hex: Array.from(data, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')),
  });
  if (trace.length > 200) {
    trace.splice(0, trace.length - 200);
  }
}

type TerminalFrameParentCommand = {
  type?: string;
  sessionID?: string;
  channel_token?: string;
  action?: 'focus' | 'send-data' | 'send-key' | 'paste' | 'toggle-keyboard' | 'set-keyboard-visible' | 'toggle-joystick' | 'set-joystick-visible' | 'apply-settings' | 'apply-background' | 'refit' | 'set-resize-suspended' | 'set-mouse-tracking' | 'upload-file';
  data?: string;
  enabled?: boolean;
  key?: TerminalSpecialKey;
  shell?: TerminalUploadShell;
  suspended?: boolean;
  visible?: boolean;
  settings?: UISettings;
  wallpaperURL?: string;
};

type TerminalFrameConfig = {
  ready: boolean;
  ticket: string;
  channelToken: string;
  parentOrigin: string;
  mouseTracking: boolean;
};

function terminalFrameConfig(): TerminalFrameConfig {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const ticket = params.get('ticket')?.trim() ?? '';
  const channelToken = params.get('channel_token')?.trim() ?? '';
  const parentOrigin = params.get('parent_origin')?.trim() ?? '';
  const mouseTracking = params.get('mouse_tracking') === '1';
  return {
    ready: Boolean(ticket && channelToken && parentOrigin),
    ticket,
    channelToken,
    parentOrigin,
    mouseTracking,
  };
}

const TERMINAL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

function terminalFrameBackground(wallpaperURL: string): string {
  if (!wallpaperURL) {
    return 'radial-gradient(circle at 15% 18%, rgba(0,255,65,0.16), transparent 28%), radial-gradient(circle at 80% 12%, rgba(171,199,255,0.16), transparent 25%), linear-gradient(145deg, #071006 0%, #0f150e 48%, #1b211a 100%)';
  }
  return `linear-gradient(rgba(7,16,6,0.36), rgba(7,16,6,0.58)), url(${JSON.stringify(wallpaperURL)}) center / cover no-repeat`;
}

async function buildTerminalUploadCommand(file: File, shell: TerminalUploadShell): Promise<string> {
  if (file.size > TERMINAL_UPLOAD_MAX_BYTES) {
    throw new Error(`Terminal upload is limited to ${Math.floor(TERMINAL_UPLOAD_MAX_BYTES / 1024 / 1024)} MiB. Use File Manager download/upload workflows or an external transfer tool for larger files.`);
  }
  const base64 = wrapBase64(bytesToBase64(new Uint8Array(await file.arrayBuffer())));
  const filename = safeUploadFilename(file.name || 'upload.bin');
  if (shell === 'powershell') {
    return [
      `$shellorchestraFile = ${powershellSingleQuotedString(filename)}`,
      "$shellorchestraB64 = @'",
      base64,
      "'@",
      '$shellorchestraTarget = Join-Path (Get-Location) $shellorchestraFile',
      '[IO.File]::WriteAllBytes($shellorchestraTarget, [Convert]::FromBase64String(($shellorchestraB64 -replace "\\s", "")))',
      'Write-Host ("ShellOrchestra upload complete: " + $shellorchestraTarget)',
      '',
    ].join('\n');
  }
  const quotedFilename = posixSingleQuotedString(filename);
  return [
    "shellorchestra_upload_tmp=$(mktemp \"${TMPDIR:-/tmp}/shellorchestra-upload.XXXXXX\") || exit 1",
    "shellorchestra_upload_b64=\"$shellorchestra_upload_tmp.b64\"",
    `cat > "$shellorchestra_upload_b64" <<'SHELLORCHESTRA_UPLOAD_B64'`,
    base64,
    'SHELLORCHESTRA_UPLOAD_B64',
    `if base64 -d "$shellorchestra_upload_b64" > "$shellorchestra_upload_tmp" 2>/dev/null; then :; elif base64 -D "$shellorchestra_upload_b64" > "$shellorchestra_upload_tmp" 2>/dev/null; then :; else echo "ShellOrchestra upload failed: base64 decoder is not available." >&2; rm -f "$shellorchestra_upload_tmp" "$shellorchestra_upload_b64"; exit 1; fi`,
    `mv -f "$shellorchestra_upload_tmp" ./${quotedFilename}`,
    'rm -f "$shellorchestra_upload_b64"',
    `printf 'ShellOrchestra upload complete: %s\\n' ./${quotedFilename}`,
    '',
  ].join('\n');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\n') ?? '';
}

function safeUploadFilename(value: string): string {
  const candidate = value.split(/[\\/]/).pop()?.trim() || 'upload.bin';
  const safe = candidate.replace(/[\x00-\x1f\x7f]/g, '_');
  if (safe === '.' || safe === '..' || safe === '') return 'upload.bin';
  return safe;
}

function posixSingleQuotedString(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function powershellSingleQuotedString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function terminalKeyboardEventSequence(event: KeyboardEvent): string {
  if (event.type !== 'keydown' || event.metaKey) return '';
  if (event.ctrlKey && event.altKey) return '';
  if (event.altKey && !event.ctrlKey) {
    const altPrintable = printableKeyFromEvent(event);
    return altPrintable ? terminalAltSequence(altPrintable) : '';
  }
  if (event.ctrlKey) {
    return terminalCtrlKeySequence(event);
  }
  if (event.shiftKey && event.key === 'Tab') return '\x1b[Z';
  const specialKey = terminalSpecialKeyFromEvent(event);
  return specialKey ? terminalSpecialKeySequence(specialKey) : '';
}

function terminalKeyboardEventBelongsToTerminal(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.metaKey || (event.ctrlKey && event.altKey)) return false;
  if (event.ctrlKey && !event.altKey) return true;
  if (event.altKey && !event.ctrlKey && Boolean(printableKeyFromEvent(event))) return true;
  if (event.shiftKey && event.key === 'Tab') return true;
  return Boolean(terminalSpecialKeyFromEvent(event));
}

function isShellOrchestraReservedTmuxPrefix(event: KeyboardEvent): boolean {
  return event.type === 'keydown'
    && event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && event.code === 'Backslash';
}

function terminalCtrlKeySequence(event: KeyboardEvent): string {
  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) return terminalCtrlSequence(code.slice(3).toLowerCase());
  switch (event.key) {
    case '@':
    case '2':
      return '\x00';
    case '[':
      return '\x1b';
    case '\\':
      return '\x1c';
    case ']':
      return '\x1d';
    case '^':
    case '6':
      return '\x1e';
    case '_':
    case '-':
      return '\x1f';
    case '?':
      return '\x7f';
    case ' ':
    case 'Spacebar':
      return '\x00';
    default:
      return '';
  }
}

function printableKeyFromEvent(event: KeyboardEvent): string {
  if (event.key.length !== 1) return '';
  return event.key;
}

function terminalSpecialKeyFromEvent(event: KeyboardEvent): TerminalSpecialKey | '' {
  if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) return event.key as TerminalSpecialKey;
  switch (event.key) {
    case 'ArrowUp':
      return 'ArrowUp';
    case 'ArrowDown':
      return 'ArrowDown';
    case 'ArrowLeft':
      return 'ArrowLeft';
    case 'ArrowRight':
      return 'ArrowRight';
    case 'Home':
      return 'Home';
    case 'End':
      return 'End';
    case 'PageUp':
      return 'PageUp';
    case 'PageDown':
      return 'PageDown';
    case 'Insert':
      return 'Insert';
    case 'Delete':
      return 'Delete';
    case 'Escape':
      return 'Escape';
    case 'Tab':
      return 'Tab';
    case 'Enter':
      return 'Enter';
    case 'Backspace':
      return 'Backspace';
    default:
      return '';
  }
}

function applyTerminalSettings(
  terminal: Terminal | null,
  fit: FitAddon | null,
  container: HTMLDivElement | null,
  settings: UISettings,
  settingsRef: MutableRefObject<UISettings>,
  socketRef: MutableRefObject<WebSocket | null>,
  pendingMessagesRef: MutableRefObject<TerminalStreamClientMessage[]>,
  frameRef: MutableRefObject<number | null>,
  timersRef: MutableRefObject<number[]>,
  resizeReconcileTimerRef: MutableRefObject<number | null>,
  resizeInputHoldUntilRef: MutableRefObject<number>,
  resizeSuspendedRef: MutableRefObject<boolean>,
  writeQueueRef: MutableRefObject<Promise<void>>,
  desiredResizeRef: MutableRefObject<TerminalDesiredResize | null>,
) {
  settingsRef.current = settings;
  if (!terminal) return;
  terminal.options.fontSize = effectiveTerminalFontSize(settings);
  terminal.options.scrollback = settings.terminal_scrollback_lines;
  terminal.options.cursorStyle = effectiveTerminalCursorStyle(settings.terminal_cursor_style);
  applyTouchKeyboardPolicy(container, settings.terminal_suppress_touch_keyboard);
  if (fit) {
    scheduleTerminalFitBurst(terminal, fit, socketRef, pendingMessagesRef, frameRef, timersRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
  }
}

function waitForTerminalFonts(): Promise<void> {
  if (!document.fonts?.ready) {
    return Promise.resolve();
  }
  return document.fonts.ready.then(() => undefined, () => undefined);
}

function terminalVisibleBufferText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY);
  const rows = Math.max(1, terminal.rows || 24);
  const lines: string[] = [];
  for (let offset = 0; offset < rows; offset += 1) {
    const line = buffer.getLine(start + offset);
    lines.push(line?.translateToString(true) ?? '');
  }
  const bufferText = lines.join('\n');
  if (bufferText.trim()) return bufferText;
  return document.querySelector<HTMLElement>('.xterm-rows')?.textContent ?? bufferText;
}

function terminalPromptCursorFallbackRows(terminal: Terminal, message: TerminalStreamServerMessage): TerminalPatchedRowPayload[] {
  const cursorY = typeof message.cursor?.y === 'number' && Number.isFinite(message.cursor.y) ? Math.floor(message.cursor.y) : -1;
  if (cursorY < 0 || cursorY >= terminal.rows) return [];
  const rows = safeTerminalPatchedRows(message.rows);
  if (rows.length > 0) return [];
  const line = terminal.buffer.active.getLine(Math.max(0, terminal.buffer.active.viewportY) + cursorY);
  const text = line?.translateToString(true) ?? '';
  if (!text) return [];
  return [{ row: cursorY, runs: [{ col: 0, text, width: text.length, style: {} }] }];
}

function updateTerminalCursorOverlay(terminal: Terminal, container: HTMLDivElement | null, cursor: HTMLDivElement | null) {
  if (!container || !cursor || terminal.cols <= 0 || terminal.rows <= 0) return;
  const screen = container.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return;
  const containerRect = container.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  if (screenRect.width <= 0 || screenRect.height <= 0) return;
  const metrics = terminalCellMetrics(terminal);
  const rowElements = Array.from(container.querySelectorAll<HTMLElement>('.xterm-rows > div'));
  const rowMetric = terminalRowMetric(rowElements);
  const cellWidth = metrics.width || containerRect.width / terminal.cols || screenRect.width / terminal.cols;
  const cellHeight = rowMetric.height || metrics.height || containerRect.height / terminal.rows || screenRect.height / terminal.rows;
  const x = Math.max(0, Math.min(terminal.buffer.active.cursorX, terminal.cols - 1));
  const y = Math.max(0, Math.min(terminal.buffer.active.cursorY, terminal.rows - 1));
  const left = screenRect.left - containerRect.left + x * cellWidth;
  const rowRect = rowElements[y]?.getBoundingClientRect();
  const top = rowRect
    ? rowRect.bottom - containerRect.top - 5
    : screenRect.top - containerRect.top + rowMetric.offset + (y + 1) * cellHeight - 5;
  cursor.style.width = `${Math.max(8, cellWidth * 0.9)}px`;
  cursor.style.transform = `translate3d(${left.toFixed(2)}px, ${Math.max(0, top).toFixed(2)}px, 0)`;
  cursor.style.opacity = container.contains(document.activeElement) ? '1' : '0.68';
}

function terminalRowMetric(rows: HTMLElement[]): { height: number; offset: number } {
  const first = rows[0]?.getBoundingClientRect();
  const second = rows[1]?.getBoundingClientRect();
  if (first && second && second.top > first.top) {
    return { height: second.top - first.top, offset: first.top - (rows[0]?.parentElement?.getBoundingClientRect().top ?? first.top) };
  }
  if (first && first.height > 0) {
    return { height: first.height, offset: first.top - (rows[0]?.parentElement?.getBoundingClientRect().top ?? first.top) };
  }
  return { height: 0, offset: 0 };
}

function terminalCellMetrics(terminal: Terminal): { width: number; height: number } {
  const candidate = terminal as Terminal & {
    _core?: {
      _renderService?: {
        dimensions?: {
          css?: {
            cell?: {
              width?: unknown;
              height?: unknown;
            };
          };
        };
      };
    };
  };
  const cell = candidate._core?._renderService?.dimensions?.css?.cell;
  const width = typeof cell?.width === 'number' && Number.isFinite(cell.width) ? cell.width : 0;
  const height = typeof cell?.height === 'number' && Number.isFinite(cell.height) ? cell.height : 0;
  return { width, height };
}

function terminalMouseButtonCode(event: MouseEvent): number | null {
  if (event.button === 0) return 0;
  if (event.button === 1) return 1;
  return null;
}

function terminalRightClickReservedForPaste(event: MouseEvent): boolean {
  return event.button === 2;
}

function terminalMouseTrackingEnabled(
  alternateScreenRef: MutableRefObject<boolean>,
  forcedMouseTrackingRef: MutableRefObject<boolean>,
  detectedMouseTrackingRef: MutableRefObject<boolean>,
): boolean {
  return alternateScreenRef.current || forcedMouseTrackingRef.current || detectedMouseTrackingRef.current;
}

function terminalMouseMotionButtonCode(buttons: number): number | null {
  if ((buttons & 1) !== 0) return 0;
  if ((buttons & 4) !== 0) return 1;
  return null;
}

function terminalMouseModifierCode(event: MouseEvent | WheelEvent): number {
  let value = 0;
  if (event.shiftKey) value += 4;
  if (event.altKey) value += 8;
  if (event.ctrlKey) value += 16;
  return value;
}

function terminalMouseSequence(terminal: Terminal, event: MouseEvent | WheelEvent, buttonCode: number, press: boolean): string {
  const point = terminalMouseCellPoint(terminal, event);
  return `\x1b[<${buttonCode};${point.col};${point.row}${press ? 'M' : 'm'}`;
}

function terminalMouseCellPoint(terminal: Terminal, event: MouseEvent | WheelEvent): { col: number; row: number } {
  const screen = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null;
  const rect = (screen ?? terminal.element)?.getBoundingClientRect();
  const cols = Math.max(1, terminal.cols || 80);
  const rows = Math.max(1, terminal.rows || 24);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { col: 1, row: 1 };
  }
  const col = clampNumber(Math.floor(((event.clientX - rect.left) / rect.width) * cols) + 1, 1, cols);
  const row = clampNumber(Math.floor(((event.clientY - rect.top) / rect.height) * rows) + 1, 1, rows);
  return { col, row };
}

function TerminalFrameMessage({ severity, title, message }: { severity: 'error' | 'warning'; title: string; message: string }) {
  return (
    <Stack spacing={1.5} sx={{ minHeight: '100vh', p: 2, justifyContent: 'center', bgcolor: '#020602' }}>
      <Alert severity={severity} variant="outlined">
        <Typography sx={{ fontWeight: 800 }}>{title}</Typography>
        <Typography variant="body2">{message}</Typography>
      </Alert>
      <Button size="small" variant="outlined" onClick={() => window.location.reload()}>Retry</Button>
    </Stack>
  );
}


type TerminalStreamServerMessage = {
  type?: string;
  message?: string;
  session_id?: string;
  base_revision?: number;
  revision?: number;
  resize_seq?: number;
  frame?: TerminalFramePayload;
  rows?: TerminalVisualRowPayload[] | TerminalPatchedRowPayload[];
  cursor?: TerminalCursorPayload;
  cols?: number;
  terminal_rows?: number;
  alternate_on?: boolean;
  title?: string;
  status?: string;
  input_modes?: Record<string, unknown>;
};

type TerminalStreamClientMessage = {
  type: 'input' | 'paste' | 'resize' | 'redraw';
  data?: string;
  cols?: number;
  rows?: number;
  resize_seq?: number;
};

type TerminalDesiredResize = {
  cols: number;
  rows: number;
  resizeSeq: number;
  expiresAt: number;
  satisfiedAt?: number;
};

type TerminalFramePayload = {
  cols?: number;
  rows?: number;
  alternate_on?: boolean;
  title?: string;
  input_modes?: Record<string, unknown>;
  history_rows?: TerminalVisualRowPayload[];
  screen_rows?: TerminalVisualRowPayload[];
  cursor?: TerminalCursorPayload;
};

type TerminalVisualRowPayload = {
  runs?: TerminalVisualRunPayload[];
};

type TerminalPatchedRowPayload = TerminalVisualRowPayload & {
  row?: number;
};

type TerminalVisualRunPayload = {
  col?: number;
  text?: string;
  width?: number;
  style?: TerminalVisualStylePayload;
};

type TerminalVisualStylePayload = {
  fg?: string | null;
  bg?: string | null;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};

type TerminalCursorPayload = {
  x?: number;
  y?: number;
  visible?: boolean;
};

function terminalStreamURL(sessionID: string, ticket: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/terminals/${encodeURIComponent(sessionID)}/stream?ticket=${encodeURIComponent(ticket)}`;
}

function sendTerminalStreamMessage(socket: WebSocket | null, message: TerminalStreamClientMessage, pendingQueue?: TerminalStreamClientMessage[], onUnavailable?: () => void) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if ((!socket || socket.readyState === WebSocket.CONNECTING) && pendingQueue) {
      queuePendingTerminalMessage(pendingQueue, message);
      return;
    }
    onUnavailable?.();
    return;
  }
  socket.send(JSON.stringify(message));
}

function queuePendingTerminalMessage(queue: TerminalStreamClientMessage[], message: TerminalStreamClientMessage) {
  if (message.type === 'resize') {
    const existing = queue.findIndex((item) => item.type === 'resize');
    if (existing >= 0) {
      queue[existing] = message;
      return;
    }
  }
  queue.push(message);
  if (queue.length > 100) {
    queue.splice(0, queue.length - 100);
  }
}

function sendTerminalResize(
  socket: WebSocket | null,
  cols: number,
  rows: number,
  pendingQueue?: TerminalStreamClientMessage[],
  desiredResizeRef?: MutableRefObject<TerminalDesiredResize | null>,
) {
  const resizeSeq = nextTerminalResizeSeq();
  if (desiredResizeRef) {
    desiredResizeRef.current = { cols, rows, resizeSeq, expiresAt: performance.now() + 9000 };
  }
  sendTerminalStreamMessage(socket, { type: 'resize', cols, rows, resize_seq: resizeSeq }, pendingQueue);
}

function shouldIgnoreStaleResizeFrame(
  resizeSeq: number,
  cols: number,
  rows: number,
  desiredResizeRef: MutableRefObject<TerminalDesiredResize | null>,
): boolean {
  const desired = desiredResizeRef.current;
  if (!desired) return false;
  if (resizeSeq > 0 && resizeSeq < desired.resizeSeq) return true;
  if (desired.cols === cols && desired.rows === rows) return false;
  if (performance.now() > desired.expiresAt) {
    desiredResizeRef.current = null;
    return false;
  }
  return true;
}

function terminalFrameHasVisibleText(frame: TerminalFramePayload): boolean {
  const rows = [...safeTerminalRows(frame.history_rows), ...safeTerminalRows(frame.screen_rows)];
  for (const row of rows) {
    for (const run of safeTerminalRuns(row.runs)) {
      if (safeTerminalRunText(run.text).trim()) return true;
    }
  }
  return false;
}

let terminalResizeSequence = 0;

function nextTerminalResizeSeq(): number {
  terminalResizeSequence = (terminalResizeSequence % 1_000_000_000) + 1;
  return terminalResizeSequence;
}

function clearSatisfiedDesiredResize(resizeSeq: number, cols: number, rows: number, desiredResizeRef: MutableRefObject<TerminalDesiredResize | null>) {
  const desired = desiredResizeRef.current;
  if (!desired) return;
  if ((resizeSeq === 0 || resizeSeq >= desired.resizeSeq) && desired.cols === cols && desired.rows === rows) {
    const now = performance.now();
    if (!desired.satisfiedAt) {
      desiredResizeRef.current = { ...desired, satisfiedAt: now, expiresAt: Math.min(desired.expiresAt, now + 3500) };
      return;
    }
    if (now >= desired.expiresAt) {
      desiredResizeRef.current = null;
    }
  }
}

function holdTerminalInputDuringResize(holdUntilRef: MutableRefObject<number>, durationMs: number) {
  holdUntilRef.current = Math.max(holdUntilRef.current, performance.now() + durationMs);
}

function scheduleTerminalResizeReconcile(
  socketRef: MutableRefObject<WebSocket | null>,
  pendingMessagesRef: MutableRefObject<TerminalStreamClientMessage[]>,
  timerRef: MutableRefObject<number | null>,
  resizeInputHoldUntilRef: MutableRefObject<number>,
) {
  holdTerminalInputDuringResize(resizeInputHoldUntilRef, 760);
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
  }
  timerRef.current = window.setTimeout(() => {
    timerRef.current = null;
    sendTerminalStreamMessage(socketRef.current, { type: 'redraw' }, pendingMessagesRef.current);
  }, 620);
}

function scheduleTerminalRedrawBurst(
  socketRef: MutableRefObject<WebSocket | null>,
  pendingMessagesRef: MutableRefObject<TerminalStreamClientMessage[]>,
  timersRef: MutableRefObject<number[]>,
  delays: number[],
) {
  for (const delay of delays) {
    const timer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((item) => item !== timer);
      sendTerminalStreamMessage(socketRef.current, { type: 'redraw' }, pendingMessagesRef.current);
    }, delay);
    timersRef.current.push(timer);
  }
}

function scheduleTerminalFitBurst(
  terminal: Terminal,
  fit: FitAddon,
  socketRef: MutableRefObject<WebSocket | null>,
  pendingMessagesRef: MutableRefObject<TerminalStreamClientMessage[]>,
  frameRef: MutableRefObject<number | null>,
  timersRef: MutableRefObject<number[]>,
  resizeReconcileTimerRef: MutableRefObject<number | null>,
  resizeInputHoldUntilRef: MutableRefObject<number>,
  resizeSuspendedRef: MutableRefObject<boolean>,
  writeQueueRef: MutableRefObject<Promise<void>>,
  desiredResizeRef: MutableRefObject<TerminalDesiredResize | null>,
) {
  scheduleTerminalFit(terminal, fit, socketRef, pendingMessagesRef, frameRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
  for (const delay of [50, 150, 350, 800]) {
    const timer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((item) => item !== timer);
      scheduleTerminalFit(terminal, fit, socketRef, pendingMessagesRef, frameRef, resizeReconcileTimerRef, resizeInputHoldUntilRef, resizeSuspendedRef, writeQueueRef, desiredResizeRef);
    }, delay);
    timersRef.current.push(timer);
  }
}

function handleTerminalStreamText(
  terminal: Terminal,
  payload: string,
  setErrorMessage: (message: string) => void,
  setTerminalUnavailable: (value: boolean) => void,
  streamErrorRef: MutableRefObject<boolean>,
  writeQueueRef: MutableRefObject<Promise<void>>,
  revisionRef: MutableRefObject<number>,
  socketRef: MutableRefObject<WebSocket | null>,
  pendingMessagesRef: MutableRefObject<TerminalStreamClientMessage[]>,
  desiredResizeRef: MutableRefObject<TerminalDesiredResize | null>,
  alternateScreenRef: MutableRefObject<boolean>,
  detectedMouseTrackingRef: MutableRefObject<boolean>,
) {
  let message: TerminalStreamServerMessage;
  try {
    message = JSON.parse(payload) as TerminalStreamServerMessage;
  } catch {
    setErrorMessage('Terminal stream returned an invalid control message.');
    return;
  }
  switch (message.type) {
    case 'full_sync': {
      const frame = message.frame;
      if (!frame) {
        setErrorMessage('Terminal stream returned a full sync without a frame.');
        return;
      }
      updateTerminalInputState(message, frame, alternateScreenRef, detectedMouseTrackingRef);
      const rows = safePositiveInt(frame.rows, terminal.rows || 24);
      const cols = safePositiveInt(frame.cols, terminal.cols || 80);
      const resizeSeq = safeNonNegativeInt(message.resize_seq, 0);
      if (shouldIgnoreStaleResizeFrame(resizeSeq, cols, rows, desiredResizeRef)) {
        sendTerminalStreamMessage(socketRef.current, { type: 'redraw' }, pendingMessagesRef.current);
        return;
      }
      if (desiredResizeRef.current && !terminalFrameHasVisibleText(frame)) {
        if (terminal.rows !== rows || terminal.cols !== cols) {
          terminal.resize(cols, rows);
        }
        sendTerminalStreamMessage(socketRef.current, { type: 'redraw' }, pendingMessagesRef.current);
        return;
      }
      clearSatisfiedDesiredResize(resizeSeq, cols, rows, desiredResizeRef);
      if (terminal.rows !== rows || terminal.cols !== cols) {
        terminal.resize(cols, rows);
      }
      revisionRef.current = safeNonNegativeInt(message.revision, revisionRef.current);
      queueTerminalResetAndWrite(terminal, compileTerminalFullFrame(frame), writeQueueRef);
      return;
    }
    case 'append_rows': {
      updateTerminalInputState(message, undefined, alternateScreenRef, detectedMouseTrackingRef);
      const desired = desiredResizeRef.current;
      const resizeSeq = safeNonNegativeInt(message.resize_seq, 0);
      if (desired && resizeSeq > 0 && resizeSeq < desired.resizeSeq) {
        sendTerminalStreamMessage(socketRef.current, { type: 'redraw' });
        return;
      }
      if (safeNonNegativeInt(message.base_revision, -1) !== revisionRef.current) {
        sendTerminalStreamMessage(socketRef.current, { type: 'redraw' });
        return;
      }
      queueTerminalWrite(terminal, compileTerminalAppendRows(message, { rows: terminal.rows, cols: terminal.cols }), writeQueueRef);
      revisionRef.current = safeNonNegativeInt(message.revision, revisionRef.current);
      return;
    }
    case 'patch_rows': {
      updateTerminalInputState(message, undefined, alternateScreenRef, detectedMouseTrackingRef);
      const desired = desiredResizeRef.current;
      const resizeSeq = safeNonNegativeInt(message.resize_seq, 0);
      if (desired && resizeSeq > 0 && resizeSeq < desired.resizeSeq) {
        sendTerminalStreamMessage(socketRef.current, { type: 'redraw' });
        return;
      }
      if (safeNonNegativeInt(message.base_revision, -1) !== revisionRef.current) {
        sendTerminalStreamMessage(socketRef.current, { type: 'redraw' });
        return;
      }
      queueTerminalWrite(terminal, compileTerminalPatchRows(message, { rows: terminal.rows, cols: terminal.cols }, terminalPromptCursorFallbackRows(terminal, message)), writeQueueRef);
      revisionRef.current = safeNonNegativeInt(message.revision, revisionRef.current);
      return;
    }
    case 'resize_ack':
      return;
    case 'error': {
      const errorMessage = message.message || 'Terminal stream failed.';
      streamErrorRef.current = true;
      setErrorMessage(errorMessage);
      if (terminalSessionUnavailableMessage(errorMessage)) {
        setTerminalUnavailable(true);
      }
      return;
    }
    default:
      return;
  }
}

function updateTerminalInputState(
  message: TerminalStreamServerMessage,
  frame: TerminalFramePayload | undefined,
  alternateScreenRef: MutableRefObject<boolean>,
  detectedMouseTrackingRef: MutableRefObject<boolean>,
) {
  const alternate = typeof frame?.alternate_on === 'boolean'
    ? frame.alternate_on
    : typeof message.alternate_on === 'boolean'
      ? message.alternate_on
      : undefined;
  if (typeof alternate === 'boolean') {
    alternateScreenRef.current = alternate;
  }
  const inputModes = frame?.input_modes ?? message.input_modes;
  if (inputModes && typeof inputModes.mouse_tracking === 'boolean') {
    detectedMouseTrackingRef.current = inputModes.mouse_tracking;
  }
}

function compileTerminalFullFrame(frame: TerminalFramePayload): string {
  const screenRows = safeTerminalRows(frame.screen_rows);
  const rows = [...safeTerminalRows(frame.history_rows), ...screenRows];
  let output = '\x1b[?25l\x1b[2J\x1b[3J\x1b[H';
  rows.forEach((row, index) => {
    if (index > 0) output += '\r\n';
    output += compileTerminalRow(row);
  });
  output += compileTerminalCursor(adjustTerminalCursorForPromptEraseArtifact(frame.cursor, screenRows), { rows: safePositiveInt(frame.rows, 24), cols: safePositiveInt(frame.cols, 80) });
  return output;
}

function compileTerminalAppendRows(message: TerminalStreamServerMessage, dimensions: { rows: number; cols: number }): string {
  const rows = safeTerminalRows(message.rows);
  let output = '\x1b[?25l';
  for (const row of rows) {
    output += `\x1b[0m\x1b[${safePositiveInt(dimensions.rows, 24)};1H\r\n\x1b[2K`;
    output += compileTerminalRow(row);
  }
  output += compileTerminalCursor(message.cursor, dimensions);
  return output;
}

function compileTerminalPatchRows(message: TerminalStreamServerMessage, dimensions: { rows: number; cols: number }, cursorFallbackRows: TerminalPatchedRowPayload[] = []): string {
  const rows = safeTerminalPatchedRows(message.rows);
  let output = '\x1b[?25l';
  for (const row of rows) {
    const rowIndex = clampNumber(safeNonNegativeInt(row.row, 0), 0, Math.max(0, safePositiveInt(dimensions.rows, 24) - 1));
    output += `\x1b[0m\x1b[${rowIndex + 1};1H\x1b[2K`;
    output += compileTerminalRow(row);
  }
  output += compileTerminalCursor(adjustTerminalCursorForPromptEraseArtifact(message.cursor, rows.length > 0 ? rows : cursorFallbackRows), dimensions);
  return output;
}

function compileTerminalRow(row: TerminalVisualRowPayload): string {
  const runs = safeTerminalRuns(row.runs);
  let output = '\x1b[0m';
  for (const run of runs) {
    const text = safeTerminalRunText(run.text);
    if (!text) continue;
    output += `\x1b[${safeNonNegativeInt(run.col, 0) + 1}G`;
    output += terminalStyleToSGR(run.style) || '\x1b[0m';
    output += text;
    output += '\x1b[0m';
  }
  return output;
}

function compileTerminalCursor(cursor: TerminalCursorPayload | undefined, dimensions: { rows: number; cols: number }): string {
  const cols = safePositiveInt(dimensions.cols, 80);
  const rows = safePositiveInt(dimensions.rows, 24);
  const cursorX = clampNumber(safeNonNegativeInt(cursor?.x, 0), 0, Math.max(0, cols - 1));
  const cursorY = clampNumber(safeNonNegativeInt(cursor?.y, 0), 0, Math.max(0, rows - 1));
  const visibility = cursor?.visible === false ? '\x1b[?25l' : '\x1b[?25h';
  return `${visibility}\x1b[${cursorY + 1};${cursorX + 1}H`;
}

function adjustTerminalCursorForPromptEraseArtifact(cursor: TerminalCursorPayload | undefined, rows: TerminalVisualRowPayload[]): TerminalCursorPayload | undefined {
  if (!cursor) return cursor;
  const cursorX = safeNonNegativeInt(cursor.x, 0);
  const cursorY = safeNonNegativeInt(cursor.y, 0);
  const row = rows.find((candidate) => {
    if (!('row' in candidate)) return rows.indexOf(candidate) === cursorY;
    const rowIndex = typeof (candidate as TerminalPatchedRowPayload).row === 'number' && Number.isFinite((candidate as TerminalPatchedRowPayload).row)
      ? Math.floor((candidate as TerminalPatchedRowPayload).row as number)
      : -1;
    return rowIndex === cursorY;
  });
  if (!row || cursorX <= 0) return cursor;
  const runs = safeTerminalRuns(row.runs);
  let lineText = '';
  let lastNonSpaceEnd = -1;
  let lastNonSpace = '';
  let rowEnd = 0;
  for (const run of runs) {
    lineText += safeTerminalRunText(run.text);
    let col = safeNonNegativeInt(run.col, 0);
    for (const char of Array.from(safeTerminalRunText(run.text))) {
      const width = terminalCharacterCellWidth(char);
      if (width <= 0) continue;
      const nextCol = col + width;
      rowEnd = Math.max(rowEnd, nextCol);
      if (char.trim() !== '') {
        lastNonSpaceEnd = nextCol;
        lastNonSpace = char;
      }
      col = nextCol;
    }
  }
  if (lastNonSpaceEnd < 0 || !terminalPromptMarkerCharacter(lastNonSpace) || !terminalPromptLineContext(lineText)) return cursor;
  if (rowEnd < lastNonSpaceEnd) return cursor;
  const promptCursorX = lastNonSpaceEnd + 2;
  if (cursorX <= promptCursorX) return cursor;
  return { ...cursor, x: promptCursorX, visible: true };
}

function terminalCharacterCellWidth(char: string): number {
  if (!char) return 0;
  return 1;
}

function terminalPromptMarkerCharacter(char: string): boolean {
  return char === '$' || char === '#' || char === '%' || char === '>';
}

function terminalPromptLineContext(value: string): boolean {
  const trimmed = value.trimEnd();
  if (!trimmed) return false;
  const marker = Array.from(trimmed).at(-1) ?? '';
  if (!terminalPromptMarkerCharacter(marker)) return false;
  const prefix = trimmed.slice(0, Math.max(0, trimmed.length - marker.length)).trim();
  if (!prefix) return true;
  return /[@:~\/\\]/.test(prefix);
}

function terminalStyleToSGR(style: TerminalVisualStylePayload | undefined): string {
  const codes: string[] = [];
  if (style?.bold) codes.push('1');
  if (style?.dim) codes.push('2');
  if (style?.italic) codes.push('3');
  if (style?.underline) codes.push('4');
  if (style?.inverse) codes.push('7');
  const foreground = safeHexColor(style?.fg);
  const background = safeHexColor(style?.bg);
  if (foreground) codes.push(`38;2;${foreground.red};${foreground.green};${foreground.blue}`);
  if (background) codes.push(`48;2;${background.red};${background.green};${background.blue}`);
  return codes.length > 0 ? `\x1b[${codes.join(';')}m` : '';
}

function safeTerminalRows(value: unknown): TerminalVisualRowPayload[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is TerminalVisualRowPayload => Boolean(row) && typeof row === 'object');
}

function safeTerminalPatchedRows(value: unknown): TerminalPatchedRowPayload[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is TerminalPatchedRowPayload => Boolean(row) && typeof row === 'object');
}

function safeTerminalRuns(value: unknown): TerminalVisualRunPayload[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((run): run is TerminalVisualRunPayload => Boolean(run) && typeof run === 'object')
    .sort((left, right) => safeNonNegativeInt(left.col, 0) - safeNonNegativeInt(right.col, 0));
}

function safeTerminalRunText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function safeHexColor(value: unknown): { red: number; green: number; blue: number } | null {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  };
}

function safePositiveInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, number);
}

function safeNonNegativeInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, number);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function queueTerminalResetAndWrite(terminal: Terminal, data: string, writeQueueRef: MutableRefObject<Promise<void>>) {
  writeQueueRef.current = writeQueueRef.current
    .catch(() => undefined)
    .then(() => new Promise<void>((resolve) => {
      terminal.write(data, () => {
        const repairSequence = terminalPromptEraseCursorRepairSequence(terminal);
        const finish = () => {
          terminal.scrollToBottom();
          refreshTerminalRender(terminal);
          scheduleTerminalRenderRefreshBurst(terminal, [40, 140, 360, 900]);
          resolve();
        };
        if (repairSequence) {
          terminal.write(repairSequence, finish);
        } else {
          finish();
        }
      });
    }));
}

function queueTerminalWrite(terminal: Terminal, data: string | Uint8Array, writeQueueRef: MutableRefObject<Promise<void>>) {
  writeQueueRef.current = writeQueueRef.current
    .catch(() => undefined)
    .then(() => new Promise<void>((resolve) => {
      terminal.write(data, () => {
        const repairSequence = terminalPromptEraseCursorRepairSequence(terminal);
        if (repairSequence) {
          terminal.write(repairSequence, resolve);
        } else {
          resolve();
        }
      });
    }));
}

function terminalPromptEraseCursorRepairSequence(terminal: Terminal): string {
  const cursorX = terminal.buffer.active.cursorX;
  const cursorY = terminal.buffer.active.cursorY;
  if (cursorX <= 0 || cursorY < 0 || cursorY >= terminal.rows) return '';
  const prompt = terminalPromptCursorFromBufferLine(terminal, cursorY);
  if (!prompt) return '';
  if (cursorX <= prompt.cursorX + 1) return '';
  return compileTerminalCursor({ x: prompt.cursorX, y: prompt.cursorY, visible: true }, { rows: terminal.rows, cols: terminal.cols });
}

function terminalPromptCursorFromBufferLine(terminal: Terminal, cursorY: number): { cursorX: number; cursorY: number } | null {
  const absoluteRow = Math.max(0, terminal.buffer.active.viewportY) + cursorY;
  const line = terminal.buffer.active.getLine(absoluteRow);
  const text = line?.translateToString(true) ?? '';
  if (!terminalPromptLineContext(text)) return null;
  const chars = Array.from(text.trimEnd());
  let lastNonSpaceEnd = 0;
  for (const char of chars) {
    lastNonSpaceEnd += terminalCharacterCellWidth(char);
  }
  if (lastNonSpaceEnd <= 0) return null;
  return { cursorX: clampNumber(lastNonSpaceEnd + 2, 0, Math.max(0, terminal.cols - 1)), cursorY };
}

function scheduleTerminalFit(
  terminal: Terminal,
  fit: FitAddon,
  socketRef: MutableRefObject<WebSocket | null>,
  pendingMessagesRef: MutableRefObject<TerminalStreamClientMessage[]>,
  frameRef: MutableRefObject<number | null>,
  resizeReconcileTimerRef: MutableRefObject<number | null>,
  resizeInputHoldUntilRef: MutableRefObject<number>,
  resizeSuspendedRef: MutableRefObject<boolean>,
  writeQueueRef: MutableRefObject<Promise<void>>,
  desiredResizeRef: MutableRefObject<TerminalDesiredResize | null>,
) {
  if (frameRef.current !== null) {
    window.cancelAnimationFrame(frameRef.current);
  }
  frameRef.current = window.requestAnimationFrame(() => {
    frameRef.current = null;
    if (!terminal.element?.isConnected || resizeSuspendedRef.current) return;
    const previousCols = terminal.cols;
    const previousRows = terminal.rows;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (terminal.cols !== previousCols || terminal.rows !== previousRows) {
      sendTerminalResize(socketRef.current, terminal.cols, terminal.rows, pendingMessagesRef.current, desiredResizeRef);
      scheduleTerminalResizeReconcile(socketRef, pendingMessagesRef, resizeReconcileTimerRef, resizeInputHoldUntilRef);
    }
    refreshTerminalRender(terminal);
  });
}

function refreshTerminalRender(terminal: Terminal) {
  try {
    clearTerminalTextureAtlas(terminal);
    terminal.refresh(0, Math.max(terminal.rows - 1, 0));
  } catch {
    // The terminal can be disposed while delayed iframe layout timers are still unwinding.
  }
}

function clearTerminalTextureAtlas(terminal: Terminal) {
  const internals = terminal as Terminal & {
    _core?: {
      _renderService?: {
        clearTextureAtlas?: () => void;
      };
    };
  };
  internals._core?._renderService?.clearTextureAtlas?.();
}

function scheduleTerminalRenderRefreshBurst(terminal: Terminal, delays: number[]) {
  for (const delay of delays) {
    window.setTimeout(() => {
      if (!terminal.element?.isConnected) return;
      refreshTerminalRender(terminal);
    }, delay);
  }
}

function terminalSessionUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('terminal session was not found') || normalized.includes('server was not found');
}

const keymapENToRU: Record<string, string> = Object.freeze({
  '`': 'ъ',
  q: 'я',
  w: 'ж',
  e: 'е',
  r: 'р',
  t: 'т',
  y: 'ы',
  u: 'у',
  i: 'и',
  o: 'о',
  p: 'п',
  '[': 'ш',
  ']': 'щ',
  '\\': 'э',
  a: 'а',
  s: 'с',
  d: 'д',
  f: 'ф',
  g: 'г',
  h: 'х',
  j: 'й',
  k: 'к',
  l: 'л',
  ';': 'ю',
  "'": 'ь',
  z: 'з',
  x: 'ч',
  c: 'ц',
  v: 'в',
  b: 'б',
  n: 'н',
  m: 'м',
  '~': 'Ъ',
  '@': '"',
  '#': '№',
  '$': ';',
  '^': ':',
  '&': '?',
  Q: 'Я',
  W: 'Ж',
  E: 'Е',
  R: 'Р',
  T: 'Т',
  Y: 'Ы',
  U: 'У',
  I: 'И',
  O: 'О',
  P: 'П',
  '{': 'Ш',
  '}': 'Щ',
  '|': 'Э',
  A: 'А',
  S: 'С',
  D: 'Д',
  F: 'Ф',
  G: 'Г',
  H: 'Х',
  J: 'Й',
  K: 'К',
  L: 'Л',
  ':': 'Ю',
  '"': 'Ь',
  Z: 'З',
  X: 'Ч',
  C: 'Ц',
  V: 'В',
  B: 'Б',
  N: 'Н',
  M: 'М',
});

const keymapCyrillicToEN: Record<string, string> = Object.freeze(
  Object.fromEntries(Object.entries(keymapENToRU).filter(([, target]) => /[А-Яа-яЁё]/.test(target)).map(([source, target]) => [target, source])),
);

function mapTerminalInput(data: string, layout: TerminalKeymapLayout): string {
  const codePoints = [...data];
  if (codePoints.length !== 1 || /[\x00-\x1f\x7f]/.test(data)) return data;
  const table = layout === 'ru' ? keymapENToRU : keymapCyrillicToEN;
  return table[data] ?? data;
}

function mapTerminalInputText(data: string, layout: TerminalKeymapLayout): string {
  return [...data].map((value) => mapTerminalInput(value, layout)).join('');
}

function mapXtermData(data: string, layout: TerminalKeymapLayout): string {
  if (!data) return '';
  if (/[\x00-\x1f\x7f]/.test(data)) return data;
  return mapTerminalInputText(data, layout);
}

function isTerminalDeviceResponse(data: string): boolean {
  return /^\x1b\[[0-9?;]*[Rcn]$/.test(data);
}

function applyTouchKeyboardPolicy(container: HTMLElement | null, suppressTouchKeyboard: boolean) {
  const helperTextarea = container?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  if (!helperTextarea) return;
  helperTextarea.setAttribute('autocapitalize', 'off');
  helperTextarea.setAttribute('autocomplete', 'off');
  helperTextarea.setAttribute('autocorrect', 'off');
  helperTextarea.spellcheck = false;
  if (suppressTouchKeyboard) {
    helperTextarea.setAttribute('inputmode', 'none');
    helperTextarea.setAttribute('virtualkeyboardpolicy', 'manual');
    return;
  }
  helperTextarea.removeAttribute('inputmode');
  helperTextarea.removeAttribute('virtualkeyboardpolicy');
}
