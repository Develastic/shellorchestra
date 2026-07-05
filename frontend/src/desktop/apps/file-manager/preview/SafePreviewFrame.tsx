// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import { SandboxIFrame } from '../../app-framework/sandbox';

const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export type SafePreviewFrameProps = {
  kind: 'text' | 'markdown' | 'document' | 'spreadsheet' | 'safe_html' | 'image';
  mime?: string;
  title: string;
  text?: string;
  assetBase64?: string;
  assetURL?: string;
  truncated?: boolean;
  imageZoom?: number;
  initialScroll?: 'top' | 'bottom';
};

export function SafePreviewFrame({ kind, mime = '', title, text = '', assetBase64 = '', assetURL = '', truncated = false, imageZoom = 1, initialScroll = 'top' }: SafePreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scriptsEnabled = kind === 'markdown';
  const frameSx = {
    flex: 1,
    display: 'block',
    alignSelf: 'stretch',
    height: '100%',
    minHeight: 0,
    width: '100%',
    borderTop: '1px solid',
    borderColor: 'divider',
    bgcolor: 'rgba(0,0,0,0.28)',
  };

  useEffect(() => {
    if (!scriptsEnabled) return undefined;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (!data || data.type !== 'shellorchestra-preview-copy-url' || typeof data.url !== 'string') return;
      const url = normalizeCopyURL(data.url);
      if (!url) return;
      void navigator.clipboard.writeText(url).catch((error) => {
        console.warn('ShellOrchestra could not copy preview URL.', error);
      });
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [scriptsEnabled]);

  const cspNonce = readCSPNonce() || randomPreviewNonce();
  const copyScriptURL = scriptsEnabled ? new URL('/preview-copy.js', window.location.origin).toString() : '';
  const src = `data:text/html;charset=utf-8;base64,${toBase64UTF8(buildPreviewDocument({ kind, mime, title, text, assetBase64, assetURL, truncated, imageZoom, initialScroll, cspNonce, copyScriptURL }))}${initialScroll === 'bottom' ? '#shellorchestra-preview-bottom' : ''}`;
  return (
    <Box sx={frameSx}>
      <SandboxIFrame
        ref={frameRef}
        testID="file-manager-safe-preview-frame"
        title={title}
        src={src}
        allowScripts={scriptsEnabled}
        style={{ width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' }}
      />
    </Box>
  );
}

function buildPreviewDocument({ kind, mime, title, text, assetBase64, assetURL, truncated, imageZoom, initialScroll, cspNonce, copyScriptURL }: Required<Pick<SafePreviewFrameProps, 'kind' | 'mime' | 'title' | 'text' | 'assetBase64' | 'assetURL' | 'truncated' | 'imageZoom' | 'initialScroll'>> & { cspNonce: string; copyScriptURL: string }): string {
  const cleanTitle = escapeHTML(title);
  const bodyOpen = '<body bgcolor="#0a1009" text="#dee5d9">';
  const scrollAnchor = previewScrollAnchor(initialScroll);
  if (kind === 'text') {
    const body = `<pre>${escapeHTML(text || 'Empty file')}</pre>${truncated ? '<p><b>Preview truncated.</b> Open the file in Editor for controlled chunked access.</p>' : ''}${scrollAnchor}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${cleanTitle}</title>${previewStyle('', cspNonce)}</head>${bodyOpen}${body}</body></html>`;
  }
  if (kind === 'markdown') {
    const body = `<main class="markdown">${renderMarkdownSubset(text || 'Empty Markdown file')}</main>${truncated ? '<p><b>Preview truncated.</b> Open the file in Editor for controlled chunked access.</p>' : ''}${scrollAnchor}<script src="${escapeHTML(copyScriptURL)}" defer></script>`;
    return `<!doctype html><html><head><meta charset="utf-8">${previewCSP(cspNonce, copyScriptURL)}<title>${cleanTitle}</title>${previewStyle(markdownStyle(), cspNonce)}</head>${bodyOpen}${body}</body></html>`;
  }
  if (kind === 'document') {
    const footer = '<p class="so-preview-footer"><b>Safe simplified preview.</b> ShellOrchestra did not open the original document in this browser. Formatting, images, macros, embedded files, and active links are omitted.</p>';
    const body = `<pre>${escapeHTML(text || 'No readable text was found in the bounded safe preview.')}</pre>${truncated ? '<p class="so-preview-footer"><b>Preview truncated.</b> Download the original only if you trust this file.</p>' : ''}${footer}${scrollAnchor}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${cleanTitle}</title>${previewStyle('', cspNonce)}</head>${bodyOpen}${body}</body></html>`;
  }
  if (kind === 'spreadsheet') {
    const footer = '<p class="so-preview-footer"><b>Safe spreadsheet preview.</b> Showing the first 50 parsed rows and first 5 columns. Formulas, macros, embedded files, and links are not executed.</p>';
    const body = `<main class="spreadsheet">${renderSpreadsheetPreviewTable(text || '')}</main>${truncated ? '<p class="so-preview-footer"><b>Preview truncated.</b> Open the file in Spreadsheet Viewer for bounded row loading.</p>' : ''}${footer}${scrollAnchor}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${cleanTitle}</title>${previewStyle(spreadsheetStyle(), cspNonce)}</head>${bodyOpen}${body}</body></html>`;
  }
  if (kind === 'safe_html') {
    const footer = '<p class="so-preview-footer"><b>Safe simplified preview.</b> ShellOrchestra rendered this HTML from its owned SafeDocument model. The original file is not embedded in this browser frame.</p>';
    const body = `<main class="document">${text || '<p>No readable text was found in the bounded safe preview.</p>'}</main>${truncated ? '<p class="so-preview-footer"><b>Preview truncated.</b> Load the next chunk to continue.</p>' : ''}${footer}${scrollAnchor}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${cleanTitle}</title>${previewStyle(documentStyle(), cspNonce)}</head>${bodyOpen}${body}</body></html>`;
  }
  if (kind === 'image' && SAFE_IMAGE_MIME.has(mime) && (isSafeBase64(assetBase64) || isSafeAssetURL(assetURL))) {
    const zoomPercent = Math.round(clampImageZoom(imageZoom) * 100);
    const imageSrc = isSafeAssetURL(assetURL) ? escapeHTML(assetURL) : `data:${mime};base64,${assetBase64}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${cleanTitle}</title>${previewStyle(`.stage{min-height:100vh;box-sizing:border-box;padding:12px;display:flex;align-items:center;justify-content:center;background-color:#111;background-image:linear-gradient(45deg,rgba(255,255,255,.10) 25%,transparent 25%),linear-gradient(-45deg,rgba(255,255,255,.10) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,rgba(255,255,255,.10) 75%),linear-gradient(-45deg,transparent 75%,rgba(255,255,255,.10) 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}.stage img{display:block;width:${zoomPercent}%;max-width:none;height:auto;image-rendering:auto;box-shadow:0 0 0 1px rgba(0,0,0,.35),0 18px 44px rgba(0,0,0,.42)}`, cspNonce)}</head>${bodyOpen}<div class="stage"><img alt="${cleanTitle}" src="${imageSrc}"></div>${scrollAnchor}</body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${cleanTitle}</title>${previewStyle('', cspNonce)}</head>${bodyOpen}<pre>Preview is not available for this file.</pre>${scrollAnchor}</body></html>`;
}

function previewScrollAnchor(initialScroll: SafePreviewFrameProps['initialScroll']): string {
  if (initialScroll !== 'bottom') return '';
  return '<span id="shellorchestra-preview-bottom" aria-hidden="true"></span>';
}

function previewStyle(extra = '', cspNonce = ''): string {
  const nonceAttribute = cspNonce ? ` nonce="${escapeHTML(cspNonce)}"` : '';
  return `<style${nonceAttribute}>
html,body{margin:0;min-height:100%;background:#0a1009;color:#dee5d9;scrollbar-color:#00ff41 #0a1009;scrollbar-width:thin;}
body{overflow:auto;font-family:"Segoe UI",Inter,system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;}
pre{box-sizing:border-box;margin:0;min-height:100vh;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:"Iosevka","Iosevka Term",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.45;color:#dee5d9;background:transparent;}
p{box-sizing:border-box;margin:0;color:#b9ccb2;font-family:"Segoe UI",Inter,system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;}
.so-preview-footer{padding:8px 12px;border-top:1px solid #3b4b37;}
::-webkit-scrollbar{width:9px;height:9px;}
::-webkit-scrollbar-track{background:#0a1009;}
::-webkit-scrollbar-thumb{background:#00ff41;border:2px solid #0a1009;border-radius:8px;}
::-webkit-scrollbar-thumb:hover{background:#72ff70;}
${extra}
</style>`;
}

function markdownStyle(): string {
  return `
.markdown{box-sizing:border-box;min-height:100vh;padding:12px 14px;font-family:"Segoe UI",Inter,system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.5;color:#dee5d9;background:transparent;}
.markdown h1,.markdown h2,.markdown h3{margin:0 0 8px;color:#ebffe2;line-height:1.25;}
.markdown h1{font-size:22px}.markdown h2{font-size:18px}.markdown h3{font-size:16px}
.markdown p,.markdown ul,.markdown ol,.markdown pre,.markdown blockquote{margin:0 0 10px;}
.markdown code,.markdown pre{font-family:"Iosevka","Iosevka Term",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.markdown code{color:#72ff70;background:rgba(0,255,65,0.08);padding:1px 4px;border-radius:3px;}
.markdown pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #3b4b37;background:rgba(0,0,0,0.24);padding:8px;}
.markdown blockquote{border-left:3px solid #00ff41;padding-left:10px;color:#b9ccb2;}
.markdown .link{display:inline;appearance:none;border:0;background:transparent;margin:0;padding:0;color:#abc7ff;text-decoration:underline;text-decoration-style:dotted;font:inherit;cursor:pointer;}
.markdown .link:hover,.markdown .link:focus{color:#d7e2ff;text-decoration-style:solid;outline:none;}
.markdown .link:focus{box-shadow:0 0 0 2px rgba(171,199,255,.45);}
.markdown .media-alt{border:1px solid #3b4b37;background:rgba(171,199,255,.07);padding:8px 10px;color:#dee5d9;}
`;
}

function documentStyle(): string {
  return `
.document{box-sizing:border-box;min-height:100vh;padding:14px 16px;font-family:"Segoe UI",Inter,system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.55;color:#dee5d9;background:transparent;}
.document h1,.document h2,.document h3,.document h4,.document h5,.document h6{margin:0 0 9px;color:#ebffe2;line-height:1.25;}
.document h1{font-size:24px}.document h2{font-size:20px}.document h3{font-size:17px}.document h4,.document h5,.document h6{font-size:15px}
.document p,.document pre,.document blockquote,.document table{margin:0 0 10px;}
.document pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #3b4b37;background:rgba(0,0,0,0.24);padding:8px;font-family:"Iosevka","Iosevka Term",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;}
.document blockquote{border-left:3px solid #00ff41;padding-left:10px;color:#b9ccb2;}
.document table{border-collapse:collapse;width:100%;font-family:"Iosevka","Iosevka Term",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;}
.document td{border:1px solid #3b4b37;padding:4px 6px;vertical-align:top;overflow-wrap:anywhere;}
.document hr{border:0;border-top:1px solid #3b4b37;margin:14px 0;}
.so-safe-document__warnings{border:1px solid #fdaf00;background:rgba(253,175,0,.08);margin-bottom:12px;}
.so-safe-document__placeholder{color:#b9ccb2;font-style:italic;}
.so-safe-document__paragraph-gap{height:10px;margin:0;}
.so-safe-document__slide-marker{box-sizing:border-box;margin:18px 0 12px;border:1px solid #3b4b37;background:linear-gradient(135deg,rgba(0,255,65,.12),rgba(171,199,255,.06));padding:10px 12px;color:#ebffe2;font-family:"Iosevka","Iosevka Term",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:800;text-transform:uppercase;letter-spacing:.08em;}
.so-safe-document__slide-marker:first-child{margin-top:0;}
.so-safe-document__slide-marker span{display:inline-flex;border:1px solid #00ff41;padding:3px 7px;background:rgba(0,255,65,.08);}
`;
}

function spreadsheetStyle(): string {
  return `
.spreadsheet{box-sizing:border-box;min-height:100vh;padding:0;font-family:"Iosevka","Iosevka Term",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.35;color:#dee5d9;background:transparent;overflow:auto;}
.spreadsheet h2{position:sticky;top:0;z-index:3;margin:0;padding:8px 10px;border-bottom:1px solid #3b4b37;background:#0a1009;color:#00ff41;font-size:12px;text-transform:uppercase;letter-spacing:.08em;}
.spreadsheet table{border-collapse:collapse;width:100%;table-layout:fixed;}
.spreadsheet th,.spreadsheet td{border:1px solid #3b4b37;padding:5px 7px;vertical-align:top;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.spreadsheet th{position:sticky;top:31px;z-index:2;background:#0f150e;color:#00ff41;text-align:left;}
.spreadsheet td{background:rgba(15,21,14,.42);}
.spreadsheet tr:nth-child(even) td{background:rgba(48,55,47,.16);}
.spreadsheet .empty{padding:12px;color:#b9ccb2;font-family:"Segoe UI",Inter,system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;}
`;
}

function renderSpreadsheetPreviewTable(value: string): string {
  const rawLines = value.replace(/\r\n?/g, '\n').split('\n');
  let title = 'Spreadsheet preview';
  const rows: string[][] = [];
  for (const rawLine of rawLines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith('# ')) {
      title = line.slice(2).trim() || title;
      continue;
    }
    if (line.startsWith('[') && line.includes('] ')) {
      continue;
    }
    rows.push(line.split('\t').slice(0, 5));
    if (rows.length >= 50) break;
  }
  if (rows.length === 0) return `<h2>${escapeHTML(title)}</h2><div class="empty">No readable spreadsheet cells were found in the bounded safe preview.</div>`;
  const columnCount = Math.max(1, Math.min(5, rows.reduce((max, row) => Math.max(max, row.length), 0)));
  const header = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  const headerHTML = Array.from({ length: columnCount }, (_, index) => `<th title="${escapeHTML(header[index] || columnName(index))}">${escapeHTML(header[index] || columnName(index))}</th>`).join('');
  const bodyHTML = bodyRows.map((row) => `<tr>${Array.from({ length: columnCount }, (_, index) => `<td title="${escapeHTML(row[index] || '')}">${escapeHTML(row[index] || '')}</td>`).join('')}</tr>`).join('');
  return `<h2>${escapeHTML(title)}</h2><table><thead><tr>${headerHTML}</tr></thead><tbody>${bodyHTML}</tbody></table>`;
}

function renderMarkdownSubset(value: string): string {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let inCode = false;
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      if (inCode) {
        html.push('</pre>');
      } else {
        html.push('<pre>');
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${escapeHTML(line)}\n`);
      continue;
    }
    if (isMarkdownUnsafeHTMLLine(line) || isMarkdownHTMLOnlyLine(line)) {
      closeList();
      continue;
    }
    const rawHTML = markdownRawHTMLLineToSafeBlock(line);
    if (rawHTML) {
      closeList();
      html.push(rawHTML);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }
    closeList();
    if (/^\s*>/.test(line)) {
      html.push(`<blockquote>${renderInlineMarkdown(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
    } else {
      html.push(`<p>${renderInlineMarkdown(line)}</p>`);
    }
  }
  closeList();
  if (inCode) html.push('</pre>');
  return html.join('');
}

function markdownRawHTMLLineToSafeBlock(value: string): string {
  const line = value.trim();
  if (!line.startsWith('<') || !line.endsWith('>')) return '';
  if (/^<\s*(?:script|style|iframe|object|embed|svg)\b/i.test(line)) return '';
  const heading = /^<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>$/i.exec(line);
  if (heading) return `<h${heading[1]}>${renderInlineMarkdown(stripMarkdownHTMLTags(heading[2]))}</h${heading[1]}>`;
  const paragraph = /^<p\b[^>]*>([\s\S]*?)<\/p>$/i.exec(line);
  if (paragraph) return `<p>${renderInlineMarkdown(stripMarkdownHTMLTags(paragraph[1]))}</p>`;
  const imageAlt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(line);
  if (imageAlt) {
    const alt = stripMarkdownHTMLTags(imageAlt[1] || imageAlt[2] || imageAlt[3] || '').trim();
    return alt ? `<p class="media-alt">${renderInlineMarkdown(alt)}</p>` : '';
  }
  const text = stripMarkdownHTMLTags(line).trim();
  return text ? `<p>${renderInlineMarkdown(text)}</p>` : '';
}

function isMarkdownHTMLOnlyLine(value: string): boolean {
  const line = value.trim();
  return /^<\/?(?:div|picture|source|span|br|hr|center|section|article|figure|figcaption|script|style|iframe|object|embed|svg)\b[^>]*>$/i.test(line);
}

function isMarkdownUnsafeHTMLLine(value: string): boolean {
  const line = value.trim();
  return /^<\s*(?:script|style|iframe|object|embed|svg)\b/i.test(line);
}

function stripMarkdownHTMLTags(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]{0,500}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderInlineMarkdown(value: string): string {
  const html: string[] = [];
  const linkPattern = /\[([^\]\n]{1,120})\]\(([^)\n]{1,2048})\)/g;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(value)) !== null) {
    html.push(renderInlineMarkdownText(value.slice(index, match.index)));
    const label = match[1].trim() || match[2].trim();
    const url = normalizeCopyURL(match[2]);
    if (url) {
      const title = `Click to copy URL: ${url}`;
      html.push(`<button type="button" class="link" data-copy-url="${escapeHTML(url)}" title="${escapeHTML(title)}" aria-label="${escapeHTML(title)}">${renderInlineMarkdownText(label)}</button>`);
    } else {
      html.push(renderInlineMarkdownText(match[0]));
    }
    index = match.index + match[0].length;
  }
  html.push(renderInlineMarkdownText(value.slice(index)));
  return html.join('');
}

function renderInlineMarkdownText(value: string): string {
  const escaped = escapeHTML(value);
  return escaped
    .replace(/`([^`]{1,160})`/g, '<code>$1</code>')
    .replace(/\*\*([^*]{1,200})\*\*/g, '<strong>$1</strong>');
}

function previewCSP(cspNonce: string, scriptURL = ''): string {
  const scriptPolicy = scriptURL ? `script-src ${escapeHTML(new URL(scriptURL).origin)};` : "script-src 'none';";
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'nonce-${escapeHTML(cspNonce)}'; ${scriptPolicy}">`;
}

function normalizeCopyURL(value: string): string {
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!trimmed || trimmed.length > 2048) return '';
  if (/[<>"`]/.test(trimmed)) return '';
  return trimmed;
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || 'A';
}

function readCSPNonce(): string {
  const value = document.querySelector<HTMLMetaElement>('meta[name="shellorchestra-csp-nonce"]')?.content.trim() ?? '';
  return value === '__SHELLORCHESTRA_CSP_NONCE__' ? '' : value;
}

function randomPreviewNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/[^A-Za-z0-9]/g, '');
}

function clampImageZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(0.5, value));
}

function toBase64UTF8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case "'": return '&#39;';
      case '"': return '&quot;';
      default: return char;
    }
  });
}

function isSafeBase64(value: string): boolean {
  return value.length > 0 && value.length <= 12 * 1024 * 1024 && /^[A-Za-z0-9+/=]+$/.test(value);
}

function isSafeAssetURL(value: string): boolean {
  return value.startsWith('blob:');
}
