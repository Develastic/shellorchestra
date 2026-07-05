// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { desktopWindowPaddingCSS } from './AppControls';

export type DesktopAppStatusTone = 'default' | 'info' | 'success' | 'warning' | 'error' | 'running';

export type DesktopAppStatusItem = {
  label: string;
  value: ReactNode;
  tone?: DesktopAppStatusTone;
  title?: string;
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  onClick?: () => void;
  ariaLabel?: string;
  iconOnly?: boolean;
};

export type DesktopAppStatusMessage = {
  text: ReactNode;
  tone?: DesktopAppStatusTone;
  title?: string;
};

export function DesktopAppStatusBar({
  message,
  items,
  maxMessageLines = 1,
}: {
  message?: DesktopAppStatusMessage | ReactNode;
  items?: DesktopAppStatusItem[];
  maxMessageLines?: 1 | 2 | 3 | 4 | 5;
}) {
  const normalizedMessage = normalizeMessage(message);
  const statusItems = items?.filter((item) => item.label.trim()) ?? [];
  if (!normalizedMessage && statusItems.length === 0) return null;
  return (
    <Box
      data-desktop-app-statusbar
      sx={{
        flex: '0 0 auto',
        minHeight: 30,
        mx: `calc(-1 * ${desktopWindowPaddingCSS()})`,
        mb: `calc(-1 * ${desktopWindowPaddingCSS()})`,
        borderTop: '1px solid',
        borderColor: 'divider',
        bgcolor: 'rgba(10,16,9,0.82)',
        boxShadow: '0 -10px 32px rgba(0,0,0,0.22)',
      }}
    >
      <Stack
        direction="row"
        spacing={0.75}
        sx={{
          alignItems: 'stretch',
          minWidth: 0,
          px: desktopWindowPaddingCSS(),
          py: 0.5,
        }}
      >
        <StatusMessage message={normalizedMessage} maxLines={maxMessageLines} />
        <Box sx={{ flex: 1 }} />
        {statusItems.map((item) => (
          <StatusItem key={item.label} item={item} />
        ))}
      </Stack>
    </Box>
  );
}

function StatusMessage({ message, maxLines }: { message: DesktopAppStatusMessage | null; maxLines: number }) {
  if (!message) return null;
  const tone = message.tone ?? 'default';
  return (
    <Tooltip title={message.title || textTitle(message.text)} disableHoverListener={!message.title && typeof message.text !== 'string'} arrow>
      <Stack
        direction="row"
        spacing={0.65}
        sx={{
          alignItems: 'center',
          minWidth: 0,
          flex: '1 1 auto',
          color: toneColor(tone),
          px: 0.55,
          py: 0.15,
        }}
      >
        <StatusIcon tone={tone} />
        <Typography
          variant="caption"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: maxLines,
            WebkitBoxOrient: 'vertical',
            fontWeight: tone === 'error' || tone === 'warning' ? 800 : 600,
            lineHeight: 1.35,
          }}
        >
          {message.text}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

function StatusItem({ item }: { item: DesktopAppStatusItem }) {
  const tone = item.tone ?? 'default';
  const valueTitle = textTitle(item.value);
  const tooltipTitle = normalizedTooltipTitle(item.title, valueTitle);
  const interactive = Boolean(item.onClick);
  const content = (
    <Box
      component={interactive ? 'button' : 'div'}
      type={interactive ? 'button' : undefined}
      onClick={item.onClick}
      aria-label={item.ariaLabel}
      sx={{
        appearance: 'none',
        background: 'none',
        flex: item.width ? `0 0 ${cssSize(item.width)}` : '0 0 auto',
        width: item.width,
        minWidth: item.minWidth ?? (item.iconOnly ? 38 : 74),
        maxWidth: item.maxWidth ?? (item.width ? item.width : 220),
        px: 0.75,
        py: 0.25,
        borderLeft: '1px solid',
        borderTop: 0,
        borderRight: 0,
        borderBottom: 0,
        borderColor: 'rgba(132,150,126,0.24)',
        color: toneColor(tone),
        cursor: interactive ? 'pointer' : 'default',
        textAlign: 'left',
        '&:hover': interactive ? { bgcolor: 'rgba(0,255,65,0.08)' } : undefined,
      }}
    >
      {item.iconOnly ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 22 }}>
          {item.value}
        </Box>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 10, fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, lineHeight: 1.05, textTransform: 'uppercase', letterSpacing: 0.4 }} noWrap>
            {item.label}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', fontFamily: 'Iosevka, Iosevka Term, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontWeight: 900, lineHeight: 1.25 }} noWrap>
            {item.value}
          </Typography>
        </>
      )}
    </Box>
  );
  if (!tooltipTitle) return content;
  return (
    <Tooltip title={tooltipTitle} arrow>
      {content}
    </Tooltip>
  );
}

function StatusIcon({ tone }: { tone: DesktopAppStatusTone }) {
  const sx = { fontSize: 15, flex: '0 0 auto' };
  if (tone === 'error') return <ErrorOutlineOutlinedIcon sx={sx} />;
  if (tone === 'warning') return <WarningAmberIcon sx={sx} />;
  if (tone === 'success') return <CheckCircleOutlinedIcon sx={sx} />;
  return <InfoOutlinedIcon sx={sx} />;
}

function normalizeMessage(message: DesktopAppStatusMessage | ReactNode | undefined): DesktopAppStatusMessage | null {
  if (message === undefined || message === null || message === false) return null;
  if (typeof message === 'object' && !Array.isArray(message) && 'text' in message) return message as DesktopAppStatusMessage;
  return { text: message };
}

function toneColor(tone: DesktopAppStatusTone) {
  if (tone === 'error') return 'error.main';
  if (tone === 'warning') return 'warning.main';
  if (tone === 'success') return 'success.main';
  if (tone === 'running') return 'primary.main';
  if (tone === 'info') return 'info.main';
  return 'text.primary';
}

function textTitle(value: ReactNode): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function normalizedTooltipTitle(title: string | undefined, visibleText: string): string {
  const normalizedTitle = (title ?? '').trim();
  if (!normalizedTitle) return '';
  if (visibleText && normalizedTitle === visibleText.trim()) return '';
  return normalizedTitle;
}

function cssSize(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value;
}
