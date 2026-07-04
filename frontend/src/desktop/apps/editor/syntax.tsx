// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { ReactNode } from 'react';

export type SyntaxLanguage = 'shell' | 'plain';

type SyntaxToken = {
  text: string;
  color?: string;
  fontStyle?: 'italic';
  fontWeight?: number;
};

const shellKeywords = new Set(['case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select', 'then', 'time', 'until', 'while']);
const shellBuiltins = new Set(['alias', 'bg', 'break', 'cd', 'command', 'continue', 'echo', 'eval', 'exec', 'exit', 'export', 'fg', 'getopts', 'hash', 'jobs', 'local', 'printf', 'pwd', 'read', 'readonly', 'return', 'set', 'shift', 'source', 'test', 'trap', 'type', 'ulimit', 'umask', 'unalias', 'unset', '[', '[[']);
const commonCommands = new Set(['apk', 'apt', 'apt-get', 'brew', 'cat', 'chmod', 'chown', 'cp', 'curl', 'dnf', 'docker', 'find', 'grep', 'install', 'ln', 'mkdir', 'mv', 'pacman', 'rm', 'rsync', 'sed', 'ssh', 'sshd', 'sudo', 'systemctl', 'tar', 'tee', 'touch', 'wget', 'yum', 'zypper']);

export function languageForPath(path: string, content = ''): SyntaxLanguage {
  const normalized = path.toLowerCase();
  if (content.startsWith('#!/bin/sh') || content.startsWith('#!/usr/bin/env sh') || content.startsWith('#!/bin/bash') || content.startsWith('#!/usr/bin/env bash')) return 'shell';
  if (normalized.endsWith('.sh') || normalized.endsWith('.bash') || normalized.endsWith('.zsh') || normalized.endsWith('.ksh') || normalized.endsWith('.profile') || normalized.endsWith('/profile') || normalized.endsWith('/bashrc') || normalized.endsWith('/zshrc')) return 'shell';
  return 'plain';
}

export function highlightedCode(content: string, language: SyntaxLanguage): ReactNode[] {
  if (language !== 'shell') return [content];
  const lines = content.split('\n');
  const nodes: ReactNode[] = [];
  lines.forEach((line, lineIndex) => {
    tokenizeShellLine(line).forEach((token, tokenIndex) => {
      nodes.push(<span key={`${lineIndex}:${tokenIndex}`} style={{ color: token.color, fontStyle: token.fontStyle, fontWeight: token.fontWeight }}>{token.text}</span>);
    });
    if (lineIndex < lines.length - 1) nodes.push('\n');
  });
  return nodes;
}

function tokenizeShellLine(line: string): SyntaxToken[] {
  const firstNonSpace = line.search(/\S/);
  if (firstNonSpace >= 0 && line[firstNonSpace] === '#') {
    return [{ text: line, color: '#7fb276', fontStyle: 'italic' }];
  }
  const tokens: SyntaxToken[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '#') {
      tokens.push({ text: line.slice(index), color: '#7fb276', fontStyle: 'italic' });
      break;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const { text, next } = readQuoted(line, index, char);
      tokens.push({ text, color: '#ffba93' });
      index = next;
      continue;
    }
    if (char === '$') {
      const { text, next } = readVariable(line, index);
      tokens.push({ text, color: '#9cdcfe' });
      index = next;
      continue;
    }
    const wordMatch = /^[A-Za-z_./:-][A-Za-z0-9_./:-]*/.exec(line.slice(index));
    if (wordMatch) {
      const word = wordMatch[0];
      const bare = word.replace(/^\/+/, '');
      if (shellKeywords.has(word)) {
        tokens.push({ text: word, color: '#86b7ff', fontWeight: 800 });
      } else if (shellBuiltins.has(word) || commonCommands.has(bare) || commonCommands.has(word)) {
        tokens.push({ text: word, color: '#72ff70', fontWeight: 700 });
      } else if (/^[0-9]+$/.test(word)) {
        tokens.push({ text: word, color: '#b5cea8' });
      } else {
        tokens.push({ text: word });
      }
      index += word.length;
      continue;
    }
    tokens.push({ text: char, color: /[|&;<>(){}\[\]=]/.test(char) ? '#d7ba7d' : undefined });
    index += 1;
  }
  return tokens;
}

function readQuoted(line: string, start: number, quote: string): { text: string; next: number } {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) {
      return { text: line.slice(start, index + 1), next: index + 1 };
    }
    index += 1;
  }
  return { text: line.slice(start), next: line.length };
}

function readVariable(line: string, start: number): { text: string; next: number } {
  if (line[start + 1] === '{') {
    const end = line.indexOf('}', start + 2);
    if (end >= 0) return { text: line.slice(start, end + 1), next: end + 1 };
  }
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9?#*!@-]/.exec(line.slice(start));
  if (match) return { text: match[0], next: start + match[0].length };
  return { text: '$', next: start + 1 };
}
