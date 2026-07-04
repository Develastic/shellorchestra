// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { terminalAltSequence, terminalCtrlSequence, terminalSpecialKeySequence, type TerminalSpecialKey } from './terminalSequences';

type KeyboardKey = {
  label: string;
  value?: string;
  special?: TerminalSpecialKey;
  flex?: number;
  span?: number;
  wide?: boolean;
};

type TerminalVirtualKeyboardProps = {
  visible: boolean;
  onInput: (data: string) => void;
};

const topKeys: KeyboardKey[] = [
  { label: 'Esc', special: 'Escape' },
  { label: 'Tab', special: 'Tab' },
  ...Array.from({ length: 10 }, (_, index) => ({ label: `F${index + 1}`, special: `F${index + 1}` as TerminalSpecialKey })),
];

const normalNumberRow = ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
const symbolNumberRow = ['~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+'];

const characterRowsAfterNumbers: KeyboardKey[][] = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']'].map((value) => ({ label: value.toUpperCase(), value })),
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"].map((value) => ({ label: value.toUpperCase(), value })),
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'].map((value) => ({ label: value.toUpperCase(), value })),
];

export function TerminalVirtualKeyboard({ visible, onInput }: TerminalVirtualKeyboardProps) {
  const [shift, setShift] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [symbols, setSymbols] = useState(false);

  if (!visible) return null;

  const sendKey = (key: KeyboardKey) => {
    const raw = key.special ? terminalSpecialKeySequence(key.special) : (key.value ?? '');
    if (!raw) return;
    let data = raw;
    if (!key.special) {
      const shifted = shift ? shiftCharacter(raw) : raw;
      if (ctrl) {
        data = terminalCtrlSequence(shifted);
      } else if (alt) {
        data = terminalAltSequence(shifted);
      } else {
        data = shifted;
      }
    }
    if (data) onInput(data);
    if (ctrl) setCtrl(false);
    if (alt) setAlt(false);
  };

  return (
    <Box
      data-testid="terminal-virtual-keyboard"
      sx={{
        flex: '0 0 auto',
        width: '100%',
        zIndex: 4,
        pointerEvents: 'auto',
        minWidth: 0,
        p: 0,
        borderTop: '1px solid rgba(185,204,178,0.34)',
        bgcolor: 'rgba(10,16,9,0.92)',
        boxShadow: '0 -18px 48px rgba(0,0,0,0.56), 0 0 30px rgba(0,255,65,0.14)',
        backdropFilter: 'blur(16px)',
      }}
    >
      <KeyboardRow keys={topKeys} onKey={sendKey} />
      <KeyboardRow keys={(symbols ? symbolNumberRow : normalNumberRow).map((value) => ({ label: value, value }))} onKey={sendKey} />
      {characterRowsAfterNumbers.map((row, index) => (
        <KeyboardRow key={`row-${index}`} keys={row} onKey={sendKey} indent={index === 1 ? 0.45 : index === 2 ? 0.9 : 1.35} />
      ))}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(18, minmax(0, 1fr))', gap: 0.35, mt: 0.35, px: 0.35, boxSizing: 'border-box', overflow: 'hidden' }}>
        <KeyboardButton compact gridSpan={2} label="Ctrl" active={ctrl} wide onClick={() => { setCtrl((value) => !value); setAlt(false); }} />
        <KeyboardButton compact gridSpan={2} label="Alt" active={alt} wide onClick={() => { setAlt((value) => !value); setCtrl(false); }} />
        <KeyboardButton compact gridSpan={2} label="Shift" active={shift} wide onClick={() => setShift((value) => !value)} />
        <KeyboardButton compact gridSpan={2} label="Sym" active={symbols} wide onClick={() => setSymbols((value) => !value)} />
        <KeyboardButton compact gridSpan={5} label="Space" onClick={() => onInput(' ')} />
        <KeyboardButton compact gridSpan={2} label="Del" wide onClick={() => sendKey({ label: 'Del', special: 'Delete' })} />
        <KeyboardButton compact gridSpan={3} label="Backspace" wide onClick={() => sendKey({ label: 'Backspace', special: 'Backspace' })} />
      </Box>
    </Box>
  );
}

export function TerminalVirtualJoystick({ visible, onInput }: { visible: boolean; onInput: (data: string) => void }) {
  if (!visible) return null;
  const send = (key: TerminalSpecialKey) => onInput(terminalSpecialKeySequence(key));
  return (
    <Box
      data-testid="terminal-joystick"
      sx={{
        position: 'absolute',
        right: 14,
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 80,
        pointerEvents: 'auto',
        width: 142,
        opacity: 0.58,
        filter: 'drop-shadow(0 8px 16px rgba(0,0,0,0.78)) drop-shadow(0 0 12px rgba(0,255,65,0.2))',
        transition: 'opacity 120ms ease',
        '&:hover': { opacity: 0.86 },
      }}
    >
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.65 }}>
        <KeyboardButton label="Esc" onClick={() => send('Escape')} />
        <KeyboardButton label="↑" onClick={() => send('ArrowUp')} />
        <KeyboardButton label="Home" onClick={() => send('Home')} />
        <KeyboardButton label="←" onClick={() => send('ArrowLeft')} />
        <KeyboardButton label="Enter" onClick={() => send('Enter')} />
        <KeyboardButton label="→" onClick={() => send('ArrowRight')} />
        <KeyboardButton label="Tab" onClick={() => send('Tab')} />
        <KeyboardButton label="↓" onClick={() => send('ArrowDown')} />
        <KeyboardButton label="End" onClick={() => send('End')} />
      </Box>
    </Box>
  );
}

function KeyboardRow({ keys, indent = 0, onKey }: { keys: KeyboardKey[]; indent?: number; onKey: (key: KeyboardKey) => void }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: `repeat(${keys.length}, minmax(0, 1fr))`,
        gap: 0.35,
        mt: 0.35,
        px: { xs: 0.35, sm: Math.max(0.35, indent) },
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {keys.map((key) => (
        <KeyboardButton key={`${key.label}-${key.value ?? key.special ?? ''}`} compact label={key.label} flex={key.flex} wide={key.wide} ordinary={Boolean(key.value && !key.special)} onClick={() => onKey(key)} />
      ))}
    </Box>
  );
}

function KeyboardButton({
  label,
  active = false,
  flex = 1,
  wide = false,
  ordinary = false,
  compact = false,
  gridSpan,
  onClick,
}: {
  label: string;
  active?: boolean;
  flex?: number;
  wide?: boolean;
  ordinary?: boolean;
  compact?: boolean;
  gridSpan?: number;
  onClick: () => void;
}) {
  const lastActivationRef = useRef(0);
  const activate = () => {
    const now = performance.now();
    if (now - lastActivationRef.current < 80) return;
    lastActivationRef.current = now;
    onClick();
  };
  return (
    <ButtonBase
      data-testid="terminal-virtual-key"
      data-key-label={label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      onMouseUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      onTouchStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      sx={{
        gridColumn: gridSpan ? `span ${gridSpan}` : undefined,
        flex: compact ? undefined : (ordinary ? '0 0 auto' : flex),
        width: compact ? '100%' : (ordinary ? 'clamp(34px, 3.8vw, 46px)' : undefined),
        height: compact ? undefined : (ordinary ? 'clamp(34px, 3.8vw, 46px)' : undefined),
        minWidth: compact ? 0 : (ordinary ? 'clamp(34px, 3.8vw, 46px)' : (wide ? 54 : 32)),
        minHeight: compact ? 0 : (ordinary ? 'clamp(34px, 3.8vw, 46px)' : 32),
        px: compact ? 0 : (wide ? 1.1 : 0.65),
        py: compact && !ordinary ? 0.55 : undefined,
        aspectRatio: ordinary ? '1 / 1' : undefined,
        borderRadius: 1.2,
        border: '1px solid',
        borderColor: active ? '#72ff70' : 'rgba(185,204,178,0.28)',
        color: active ? '#002203' : '#dee5d9',
        bgcolor: active ? '#72ff70' : 'rgba(48,55,47,0.78)',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: ordinary ? 'clamp(18px, 6.2vw, 37px)' : (compact ? 'clamp(9px, 2.55vw, 12px)' : 12),
        lineHeight: ordinary ? 0.92 : 1.1,
        fontWeight: ordinary ? 1000 : 900,
        overflow: 'hidden',
        boxShadow: active ? '0 0 16px rgba(114,255,112,0.28)' : 'inset 0 -2px 0 rgba(0,0,0,0.36)',
        userSelect: 'none',
        '&:hover': {
          borderColor: '#72ff70',
          bgcolor: active ? '#72ff70' : 'rgba(0,255,65,0.16)',
        },
      }}
    >
      {label}
    </ButtonBase>
  );
}

function shiftCharacter(value: string): string {
  const shiftMap: Record<string, string> = {
    '`': '~',
    '1': '!',
    '2': '@',
    '3': '#',
    '4': '$',
    '5': '%',
    '6': '^',
    '7': '&',
    '8': '*',
    '9': '(',
    '0': ')',
    '-': '_',
    '=': '+',
    '[': '{',
    ']': '}',
    ';': ':',
    "'": '"',
    ',': '<',
    '.': '>',
    '/': '?',
  };
  return shiftMap[value] ?? value.toUpperCase();
}
