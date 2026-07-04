// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type UIEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import CalculateIcon from '@mui/icons-material/Calculate';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FilterListIcon from '@mui/icons-material/FilterList';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import TableChartIcon from '@mui/icons-material/TableChart';
import type { SxProps, Theme } from '@mui/material/styles';
import type { DesktopWindowSnapshot } from '../../windowModel';
import type { Server, ServerStatus } from '../types';
import { formatBytesCompact } from '../shared';
import { DesktopAppActionList } from '../app-framework/actionList';
import { DesktopAppFrame } from '../app-framework/DesktopAppFrame';
import { DesktopAppInfoDialog } from '../app-framework/AppInfoDialog';
import { DesktopAppInfoText } from '../app-framework/AppToolbar';
import { DesktopAppStatusBar, type DesktopAppStatusMessage } from '../app-framework/AppStatusBar';
import { DesktopAppButton, DesktopAppTextField } from '../app-framework/AppControls';
import { useDesktopAppSandbox } from '../app-framework/sandbox';
import { SpreadsheetViewerService, type SafeSpreadsheetCell, type SafeSpreadsheetColumn, type SafeSpreadsheetRowsResponse, type SafeSpreadsheetSheet, type SafeSpreadsheetWorkbookResponse } from './service';
import { monoFontFamily } from '../../../theme/theme';
import { effectiveLocale, effectiveTimeZone } from '../../../settings/dateTimeFormat';
import { getUISettings } from '../../../settings/uiSettings';
import { redactDebugScreenshotText } from '../../../security/screenshotRedaction';

const spreadsheetViewerMaxBytes = 64 * 1024 * 1024;
const spreadsheetVisibleColumns = 80;
const spreadsheetInteractiveColumns = 30;
const spreadsheetRowStep = 1000;
const spreadsheetMaxRows = 5000;
const spreadsheetRowHeight = 30;
const spreadsheetOverscanRows = 8;
const emptySheets = [] as const;

type ViewerMode = 'safe' | 'interactive';
type SortDirection = 'asc' | 'desc';
type SortState = { columnIndex: number; direction: SortDirection } | null;
type FilterOperator = 'contains' | 'equals' | 'not_empty' | 'empty' | 'gt' | 'lt' | 'between';
type CalculatorFunction = 'sum' | 'average' | 'median' | 'min' | 'max' | 'count_all' | 'count_numbers' | 'count_non_empty' | 'unique_count';

type FilterState = {
  columnIndex: number;
  operator: FilterOperator;
  value: string;
  secondValue: string;
};

type CalculatorState = {
  fn: CalculatorFunction;
  fromColumn: number;
  fromRow: number;
  toColumn: number;
  toRow: number;
};

type GridRow = {
  sourceIndex: number;
  cells: SafeSpreadsheetCell[];
  header?: boolean;
};

type SpreadsheetGridColumn = {
  index: number;
  label: string;
  inferredType?: string;
  confidence?: number;
};

type SpreadsheetGridModel = {
  sheetName: string;
  startRow: number;
  rows: GridRow[];
  totalRows: number;
  columns: SpreadsheetGridColumn[];
};

type CalculatorResult = {
  label: string;
  value: string;
  scanned: number;
  numeric: number;
  ignored: number;
};

const defaultFilter: FilterState = { columnIndex: 0, operator: 'contains', value: '', secondValue: '' };
const defaultCalculator: CalculatorState = { fn: 'sum', fromColumn: 0, fromRow: 1, toColumn: 0, toRow: 10 };

export function SpreadsheetViewerApp({ server, status, windowState }: { server: Server; status?: ServerStatus; windowState: DesktopWindowSnapshot }) {
  const connected = status?.state === 'connected';
  const [infoOpen, setInfoOpen] = useState(false);
  const [selectedSheetID, setSelectedSheetID] = useState('');
  const [rowLimit, setRowLimit] = useState(spreadsheetRowStep);
  const [manualColumnWidths, setManualColumnWidths] = useState<Record<string, Record<number, number>>>({});
  const [searchText, setSearchText] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [headerOverrides, setHeaderOverrides] = useState<Record<string, boolean>>({});
  const [sortState, setSortState] = useState<SortState>(null);
  const [filterState, setFilterState] = useState<FilterState>(defaultFilter);
  const [calculatorState, setCalculatorState] = useState<CalculatorState>(defaultCalculator);
  const sandbox = useDesktopAppSandbox('spreadsheet-viewer');
  const service = useMemo(() => new SpreadsheetViewerService(server.id, sandbox), [sandbox, server.id]);
  const filePath = String(windowState.metadata?.file_path || '').trim();
  const uiSettings = useQuery({ queryKey: ['ui-settings'], queryFn: getUISettings, retry: false });
  const displayLocale = effectiveLocale(uiSettings.data);
  const displayTimeZone = effectiveTimeZone(uiSettings.data);

  const workbookQuery = useQuery({
    queryKey: ['spreadsheet-viewer-workbook', server.id, filePath],
    queryFn: () => service.workbook(filePath, spreadsheetViewerMaxBytes),
    enabled: connected && Boolean(filePath),
    retry: false,
  });

  const workbookData = workbookQuery.data;
  const sheets = workbookData?.workbook?.sheets ?? emptySheets;
  const activeSheet = sheets.find((sheet) => sheet.id === selectedSheetID) ?? sheets[0] ?? null;
  const activeSheetID = activeSheet?.id || '';
  const interactiveEligible = Boolean(activeSheet?.interactive?.eligible);
  const viewerMode: ViewerMode = interactiveEligible ? 'interactive' : 'safe';
  const autoHeaderEnabled = Boolean(activeSheet?.header?.detected);
  const headerEnabled = activeSheetID in headerOverrides ? Boolean(headerOverrides[activeSheetID]) : autoHeaderEnabled;

  useEffect(() => {
    if (!sheets.length) {
      setSelectedSheetID('');
      return;
    }
    if (!selectedSheetID || !sheets.some((sheet) => sheet.id === selectedSheetID)) {
      setSelectedSheetID(sheets[0]?.id || '');
      setRowLimit(spreadsheetRowStep);
      setSortState(null);
      setFilterState(defaultFilter);
      setCalculatorState(defaultCalculator);
    }
  }, [selectedSheetID, sheets]);

  const rowsQuery = useQuery({
    queryKey: ['spreadsheet-viewer-rows', server.id, filePath, activeSheetID, rowLimit],
    queryFn: () => service.rows(filePath, activeSheetID, 0, rowLimit, spreadsheetViewerMaxBytes),
    enabled: connected && Boolean(filePath) && Boolean(activeSheetID),
    retry: false,
  });

  const rowsData = rowsQuery.data;
  const grid = useMemo(() => gridModel(activeSheet, rowsData), [activeSheet, rowsData]);
  const displayGrid = useMemo(() => visibleGridModel(grid, viewerMode, searchText, headerEnabled, sortState, filterState), [filterState, grid, headerEnabled, searchText, sortState, viewerMode]);
  const calculatorResult = useMemo(() => calculateRange(grid, calculatorState, displayLocale), [calculatorState, displayLocale, grid]);
  const activeManualColumnWidths = manualColumnWidths[activeSheetID] ?? {};
  const setActiveColumnWidth = useCallback((columnIndex: number, width: number) => {
    if (!activeSheetID) return;
    setManualColumnWidths((current) => ({
      ...current,
      [activeSheetID]: {
        ...(current[activeSheetID] ?? {}),
        [columnIndex]: width,
      },
    }));
  }, [activeSheetID]);
  const hasMore = Boolean(rowsData?.has_more) && rowLimit < spreadsheetMaxRows;
  const canLoadMore = connected && Boolean(filePath) && viewerMode === 'safe' && hasMore && !rowsQuery.isFetching;
  const warningCount = spreadsheetWarnings(workbookData, rowsData).length;
  const transportTruncated = Boolean(workbookData?.transport?.truncated || rowsData?.transport?.truncated);

  useEffect(() => {
    if (!grid.rows.length) return;
    setCalculatorState((current) => {
      const lastRow = Math.max(1, absoluteRowNumber(grid, grid.rows[Math.min(grid.rows.length - 1, 9)]));
      return {
        ...current,
        fromRow: clampInteger(current.fromRow || (headerEnabled ? 2 : 1), 1, Math.max(1, grid.totalRows || grid.rows.length)),
        toRow: clampInteger(current.toRow || lastRow, 1, Math.max(1, grid.totalRows || grid.rows.length)),
        fromColumn: clampInteger(current.fromColumn, 0, Math.max(0, grid.columns.length - 1)),
        toColumn: clampInteger(current.toColumn, 0, Math.max(0, grid.columns.length - 1)),
      };
    });
  }, [grid, headerEnabled]);

  const actions = new DesktopAppActionList([
    { id: 'refresh', group: 'viewer', label: 'Refresh', icon: <RefreshIcon fontSize="small" />, tooltip: 'Reload the protected workbook metadata and current sheet rows from the managed server', disabled: !connected || !filePath || workbookQuery.isFetching || rowsQuery.isFetching, disabledReason: !connected ? 'Spreadsheet Viewer needs an active managed SSH connection.' : !filePath ? 'No spreadsheet path was provided.' : 'Spreadsheet Viewer is already refreshing.', run: () => { void workbookQuery.refetch(); void rowsQuery.refetch(); } },
    { id: 'load-more', group: 'viewer', label: 'Load more rows', icon: <ExpandMoreIcon fontSize="small" />, tooltip: `Load the next ${spreadsheetRowStep} protected rows from the current sheet`, disabled: !canLoadMore, disabledReason: !connected ? 'Spreadsheet Viewer needs an active managed SSH connection.' : !filePath ? 'No spreadsheet path was provided.' : viewerMode === 'interactive' ? 'Interactive mode loads the complete eligible sheet model.' : !rowsData ? 'Load spreadsheet rows before requesting more.' : !rowsData.has_more ? 'The current sheet has no additional protected rows.' : 'Spreadsheet Viewer is already loading more rows.', run: () => setRowLimit((value) => Math.min(spreadsheetMaxRows, value + spreadsheetRowStep)) },
    { id: 'search', group: 'viewer', label: searchOpen || searchText ? 'Hide search' : 'Search', icon: <SearchIcon fontSize="small" />, tooltip: searchOpen || searchText ? 'Hide the loaded-row search field' : 'Show loaded-row search', disabled: !rowsData || viewerMode !== 'safe', disabledReason: viewerMode !== 'safe' ? 'Interactive sheets use Filters and Calculator instead of protected-row search.' : 'Load spreadsheet rows before searching.', run: () => setSearchOpen((value) => !value) },
    { id: 'copy-tsv', group: 'clipboard', spacerBefore: true, label: 'Copy TSV', icon: <ContentCopyIcon fontSize="small" />, tooltip: 'Copy visible cells as TSV', disabled: !displayGrid.rows.length, disabledReason: 'Load spreadsheet rows before copying cells.', run: () => { void navigator.clipboard.writeText(displayGrid.rows.map((row) => row.cells.map((cell) => cellDisplayText(cell, displayLocale, displayTimeZone)).join('\t')).join('\n')); } },
  ]);

  const primaryError = workbookQuery.error || rowsQuery.error;
  const isInitialLoading = (workbookQuery.isFetching && !workbookData) || (rowsQuery.isFetching && !rowsData && Boolean(activeSheetID));
  const statusMessage: DesktopAppStatusMessage = primaryError
    ? { tone: 'error', text: primaryError instanceof Error ? primaryError.message : 'Spreadsheet view failed.' }
    : !connected
      ? { tone: 'warning', text: 'Spreadsheet Viewer needs an active managed SSH connection.' }
      : !filePath
        ? { tone: 'warning', text: 'No spreadsheet path was provided to this viewer window.' }
        : isInitialLoading
          ? { tone: 'running', text: `Loading spreadsheet view for ${basenameFromPath(filePath) || filePath}…` }
          : rowsData
            ? { tone: (hasMore && viewerMode === 'safe') || transportTruncated ? 'warning' : 'success', text: transportTruncated ? 'Protected prefix of a large spreadsheet loaded. The original file is larger than the safe viewer limit.' : hasMore && viewerMode === 'safe' ? 'Large-sheet rows loaded. Use Load more rows to continue.' : `${viewerMode === 'interactive' ? 'Interactive' : 'Read-only'} spreadsheet view loaded.`, title: safeSpreadsheetStatusTitle(warningCount) }
            : workbookData
              ? { tone: 'info', text: 'Workbook metadata loaded. Waiting for sheet rows.' }
              : { tone: 'info', text: 'Ready to load spreadsheet view.' };

  return (
    <DesktopAppFrame
      actions={actions}
      infoTitle="Spreadsheet Viewer"
      onInfo={() => setInfoOpen(true)}
      statusBar={(
        <DesktopAppStatusBar
          message={statusMessage}
          items={[
            { label: 'Server', value: server.name, title: redactDebugScreenshotText(server.host) },
            { label: 'Interactive', value: interactiveEligible ? 'on' : 'off', tone: interactiveEligible ? 'success' : 'warning', title: interactiveEligible ? `Interactive tools are enabled automatically for this sheet. Limits: ${activeSheet?.interactive?.max_rows ?? 300} rows, ${activeSheet?.interactive?.max_columns ?? 30} columns, ${formatBytesCompact(activeSheet?.interactive?.max_bytes ?? 10 * 1024 * 1024)} model.` : (activeSheet?.interactive?.disabled_reason || 'This sheet is outside the strict interactive limits.') },
            { label: 'Sheets', value: sheets.length || '—' },
            { label: 'Rows', value: displayGrid.rows.length || '—', title: activeSheet ? `Visible rows: ${displayGrid.rows.length}; loaded rows: ${grid.rows.length}; declared protected rows: ${activeSheet.row_count ?? 0}` : undefined },
            { label: 'Cols', value: grid.columns.length || '—', title: activeSheet ? `Detected columns: ${grid.columns.length}; declared protected columns: ${activeSheet.column_count ?? 0}` : undefined },
            { label: 'Info', value: <InfoOutlinedIcon sx={{ fontSize: 18 }} />, title: 'Show parser, header, warning, transport, and file details', onClick: () => setInfoOpen(true), ariaLabel: 'Show spreadsheet details', iconOnly: true, minWidth: 40, maxWidth: 44 },
          ]}
        />
      )}
    >
      <Stack data-testid="spreadsheet-viewer-app" spacing={0.75} sx={{ flex: 1, minHeight: 0 }}>
        {!filePath && <Alert severity="warning" variant="outlined">This viewer window was opened without a remote file path.</Alert>}
        {primaryError && <Alert severity="error" variant="outlined">{primaryError instanceof Error ? primaryError.message : 'Spreadsheet view failed.'}</Alert>}
        {sheets.length > 1 && (
          <Tabs
            value={activeSheetID}
            onChange={(_, value) => { setSelectedSheetID(String(value)); setRowLimit(spreadsheetRowStep); setSortState(null); setFilterState(defaultFilter); }}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ minHeight: 34 }}
          >
            {sheets.map((sheet, index) => <Tab key={sheet.id || `${sheet.name}-${index}`} value={sheet.id || ''} label={sheet.name || `Sheet ${index + 1}`} sx={{ minHeight: 34 }} />)}
          </Tabs>
        )}
        {rowsData && (
          <SpreadsheetControls
            activeSheet={activeSheet}
            grid={grid}
            mode={viewerMode}
            searchOpen={searchOpen}
            searchText={searchText}
            onSearchTextChange={setSearchText}
            headerEnabled={headerEnabled}
            onHeaderEnabledChange={(enabled) => activeSheetID && setHeaderOverrides((current) => ({ ...current, [activeSheetID]: enabled }))}
            sortState={sortState}
            filterState={filterState}
            onFilterChange={setFilterState}
            calculatorState={calculatorState}
            onCalculatorChange={setCalculatorState}
            calculatorResult={calculatorResult}
            locale={displayLocale}
          />
        )}
        {displayGrid.rows.length > 0 && <SpreadsheetGrid grid={displayGrid} mode={viewerMode} sortState={sortState} manualColumnWidths={activeManualColumnWidths} onColumnWidthChange={setActiveColumnWidth} onSortChange={setSortState} locale={displayLocale} timeZone={displayTimeZone} />}
        {rowsData && grid.rows.length === 0 && <Alert severity="info" variant="outlined">No cell rows were extracted from this spreadsheet sheet.</Alert>}
        {rowsData && grid.rows.length > 0 && displayGrid.rows.length === 0 && <Alert severity="info" variant="outlined">No loaded rows match the current spreadsheet search/filter.</Alert>}
      </Stack>
      <DesktopAppInfoDialog open={infoOpen} title="Spreadsheet Viewer" iconName="spreadsheet" onClose={() => setInfoOpen(false)}>
        <Stack spacing={1.25}>
          <DesktopAppInfoText>Spreadsheet Viewer renders inert typed cell values extracted by ShellOrchestra. The browser does not execute formulas, macros, OLE objects, links, or embedded files.</DesktopAppInfoText>
          <DesktopAppInfoText>Protected view handles larger sheets as bounded row ranges. Interactive view is enabled only for small sheets and loads the complete eligible typed model so sorting, filters, and calculator results are honest.</DesktopAppInfoText>
          <DesktopAppInfoText>Header detection is heuristic. Use the First row is header toggle when a sheet should be sorted or filtered with the first row pinned as labels.</DesktopAppInfoText>
          <DesktopAppInfoText>{spreadsheetDetailsText(filePath, workbookData, activeSheet, rowsData, headerEnabled, warningCount)}</DesktopAppInfoText>
        </Stack>
      </DesktopAppInfoDialog>
    </DesktopAppFrame>
  );
}

function SpreadsheetControls({ activeSheet, grid, mode, searchOpen, searchText, onSearchTextChange, headerEnabled, onHeaderEnabledChange, filterState, onFilterChange, calculatorState, onCalculatorChange, calculatorResult, locale }: {
  activeSheet: SafeSpreadsheetSheet | null;
  grid: SpreadsheetGridModel;
  mode: ViewerMode;
  searchOpen: boolean;
  searchText: string;
  onSearchTextChange: (value: string) => void;
  headerEnabled: boolean;
  onHeaderEnabledChange: (enabled: boolean) => void;
  sortState: SortState;
  filterState: FilterState;
  onFilterChange: (state: FilterState) => void;
  calculatorState: CalculatorState;
  onCalculatorChange: (state: CalculatorState) => void;
  calculatorResult: CalculatorResult;
  locale: string;
}) {
  const interactiveEligible = Boolean(activeSheet?.interactive?.eligible);
  const [toolsOpen, setToolsOpen] = useState(false);
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(15,21,14,0.74)', p: 0.75 }}>
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip
            size="small"
            color={interactiveEligible ? 'primary' : 'warning'}
            variant="outlined"
            label={interactiveEligible ? 'Interactive tools enabled' : 'Read-only large sheet'}
          />
          <Typography variant="caption" color="text.secondary">{grid.rows.length} loaded rows · {grid.columns.length} columns</Typography>
        </Stack>
        {mode === 'safe' ? (
          <Collapse in={searchOpen || Boolean(searchText)} timeout={140} unmountOnExit>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
              <DesktopAppTextField
                size="small"
                value={searchText}
                onChange={(event) => onSearchTextChange(event.target.value)}
                placeholder="Search loaded rows"
                label="Search"
                sx={{ flex: 1 }}
              />
            </Stack>
          </Collapse>
        ) : (
          <Stack spacing={0.75}>
            <DesktopAppButton
              size="small"
              variant="outlined"
              startIcon={<FilterListIcon />}
              endIcon={<ExpandMoreIcon sx={{ transform: toolsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }} />}
              onClick={() => setToolsOpen((value) => !value)}
              sx={{ alignSelf: 'flex-start' }}
            >
              Filters and calculator
            </DesktopAppButton>
            <Collapse in={toolsOpen} timeout={140} unmountOnExit>
              <Stack spacing={0.75}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <FormControlLabel
                    control={<Switch size="small" checked={headerEnabled} onChange={(event) => onHeaderEnabledChange(event.target.checked)} />}
                    label="First row is header"
                  />
                  <Typography variant="caption" color="text.secondary">Sorting keeps the header row pinned when this is enabled.</Typography>
                </Stack>
                <Divider />
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <FilterListIcon fontSize="small" color="primary" />
                  <ColumnSelect label="Filter column" value={filterState.columnIndex} columns={grid.columns} onChange={(columnIndex) => onFilterChange({ ...filterState, columnIndex })} />
                  <DesktopAppTextField select size="small" label="Operator" value={filterState.operator} onChange={(event) => onFilterChange({ ...filterState, operator: event.target.value as FilterOperator })} sx={{ width: 150 }}>
                    <MenuItem value="contains">contains</MenuItem>
                    <MenuItem value="equals">equals</MenuItem>
                    <MenuItem value="not_empty">not empty</MenuItem>
                    <MenuItem value="empty">empty</MenuItem>
                    <MenuItem value="gt">number &gt;</MenuItem>
                    <MenuItem value="lt">number &lt;</MenuItem>
                    <MenuItem value="between">number between</MenuItem>
                  </DesktopAppTextField>
                  <DesktopAppTextField size="small" label="Value" value={filterState.value} onChange={(event) => onFilterChange({ ...filterState, value: event.target.value })} sx={{ width: 170 }} disabled={filterState.operator === 'empty' || filterState.operator === 'not_empty'} />
                  {filterState.operator === 'between' && <DesktopAppTextField size="small" label="And" value={filterState.secondValue} onChange={(event) => onFilterChange({ ...filterState, secondValue: event.target.value })} sx={{ width: 120 }} />}
                  <DesktopAppButton size="small" onClick={() => onFilterChange(defaultFilter)}>Clear</DesktopAppButton>
                </Stack>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <CalculateIcon fontSize="small" color="primary" />
                  <DesktopAppTextField select size="small" label="Function" value={calculatorState.fn} onChange={(event) => onCalculatorChange({ ...calculatorState, fn: event.target.value as CalculatorFunction })} sx={{ width: 150 }}>
                    <MenuItem value="sum">Sum</MenuItem>
                    <MenuItem value="average">Average</MenuItem>
                    <MenuItem value="median">Median</MenuItem>
                    <MenuItem value="min">Min</MenuItem>
                    <MenuItem value="max">Max</MenuItem>
                    <MenuItem value="count_all">Count all</MenuItem>
                    <MenuItem value="count_numbers">Count numbers</MenuItem>
                    <MenuItem value="count_non_empty">Count non-empty</MenuItem>
                    <MenuItem value="unique_count">Unique count</MenuItem>
                  </DesktopAppTextField>
                  <ColumnSelect label="From col" value={calculatorState.fromColumn} columns={grid.columns} onChange={(fromColumn) => onCalculatorChange({ ...calculatorState, fromColumn })} />
                  <DesktopAppTextField size="small" label="From row" type="number" value={calculatorState.fromRow} onChange={(event) => onCalculatorChange({ ...calculatorState, fromRow: Number(event.target.value) || 1 })} sx={{ width: 105 }} />
                  <ColumnSelect label="To col" value={calculatorState.toColumn} columns={grid.columns} onChange={(toColumn) => onCalculatorChange({ ...calculatorState, toColumn })} />
                  <DesktopAppTextField size="small" label="To row" type="number" value={calculatorState.toRow} onChange={(event) => onCalculatorChange({ ...calculatorState, toRow: Number(event.target.value) || 1 })} sx={{ width: 105 }} />
                  <Chip size="small" color="primary" variant="outlined" label={`${calculatorResult.label}: ${calculatorResult.value}`} title={`Cells scanned: ${calculatorResult.scanned}; numeric cells: ${calculatorResult.numeric}; ignored: ${calculatorResult.ignored}; locale: ${locale}`} />
                </Stack>
              </Stack>
            </Collapse>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

function ColumnSelect({ label, value, columns, onChange }: { label: string; value: number; columns: SpreadsheetGridColumn[]; onChange: (value: number) => void }) {
  const safeColumns = columns.length ? columns.slice(0, spreadsheetInteractiveColumns) : [{ index: 0, label: 'A' }];
  return (
    <DesktopAppTextField select size="small" label={label} value={String(clampInteger(value, 0, Math.max(0, safeColumns.length - 1)))} onChange={(event) => onChange(Number(event.target.value) || 0)} sx={{ minWidth: 130 }}>
      {safeColumns.map((column) => <MenuItem key={column.index} value={String(column.index)}>{column.label || columnName(column.index)}</MenuItem>)}
    </DesktopAppTextField>
  );
}

function SpreadsheetGrid({ grid, mode, sortState, manualColumnWidths, onColumnWidthChange, onSortChange, locale, timeZone }: { grid: SpreadsheetGridModel; mode: ViewerMode; sortState: SortState; manualColumnWidths: Record<number, number>; onColumnWidthChange: (columnIndex: number, width: number) => void; onSortChange: (state: SortState) => void; locale: string; timeZone: string }) {
  const rows = grid.rows;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(420);
  const maxColumns = Math.min(mode === 'interactive' ? spreadsheetInteractiveColumns : spreadsheetVisibleColumns, Math.max(grid.columns.length, rows.reduce((max, row) => Math.max(max, row.cells.length), 0)));
  const autoWidths = useMemo(() => autoColumnWidths(rows, maxColumns, grid.columns), [grid.columns, rows, maxColumns]);
  const widths = autoWidths.map((width, index) => clampColumnWidth(manualColumnWidths[index] ?? width));
  const clippedColumns = rows.some((row) => row.cells.length > maxColumns) || grid.columns.length > maxColumns;
  const gridTemplateColumns = `48px ${widths.map((width) => `${width}px`).join(' ')}`;
  const minWidth = 48 + widths.reduce((total, width) => total + width, 0);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / spreadsheetRowHeight) + spreadsheetOverscanRows * 2);
  const visibleStart = Math.max(0, Math.floor(scrollTop / spreadsheetRowHeight) - spreadsheetOverscanRows);
  const visibleRows = rows.slice(visibleStart, visibleStart + visibleCount);
  const bodyHeight = rows.length * spreadsheetRowHeight;
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const nextTop = target.scrollTop;
    setScrollTop((current) => Math.abs(current - nextTop) > 2 ? nextTop : current);
    setViewportHeight((current) => Math.abs(current - target.clientHeight) > 2 ? target.clientHeight : current);
  }, []);
  useEffect(() => {
    const target = scrollerRef.current;
    if (!target) return;
    setViewportHeight(target.clientHeight || 420);
  }, [rows.length, maxColumns]);
  return (
    <Box ref={scrollerRef} onScroll={onScroll} sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(10,16,9,0.66)' }}>
      <Box sx={{ minWidth }}>
        <Box sx={{ display: 'grid', gridTemplateColumns, position: 'sticky', top: 0, zIndex: 4 }}>
          <GridHeader sticky sx={{ left: 0, zIndex: 5 }}><TableChartIcon fontSize="small" /></GridHeader>
          {Array.from({ length: maxColumns }, (_, index) => {
            const column = grid.columns[index];
            const sorted = sortState?.columnIndex === index ? sortState.direction : null;
            return (
              <GridHeader key={`h-${index}`} sticky resizeWidth={widths[index]} onResize={(width) => onColumnWidthChange(index, width)}>
                <Box
                  component="button"
                  type="button"
                  onClick={() => mode === 'interactive' && onSortChange(nextSortState(sortState, index))}
                  disabled={mode !== 'interactive'}
                  title={column?.inferredType ? `${column.inferredType}${column.confidence ? ` · ${Math.round(column.confidence * 100)}%` : ''}` : undefined}
                  style={{ all: 'unset', cursor: mode === 'interactive' ? 'pointer' : 'default', width: '100%', display: 'block' }}
                >
                  {column?.label || columnName(index)}{sorted ? (sorted === 'asc' ? ' ▲' : ' ▼') : ''}
                </Box>
              </GridHeader>
            );
          })}
        </Box>
        <Box sx={{ position: 'relative', height: bodyHeight, minWidth }}>
          <Box sx={{ position: 'absolute', top: visibleStart * spreadsheetRowHeight, left: 0, right: 0, display: 'grid', gridTemplateColumns }}>
            {visibleRows.map((row, localRowIndex) => {
              const virtualIndex = visibleStart + localRowIndex;
              return [
                <GridHeader key={`r-${row.sourceIndex}`} sx={{ position: 'sticky', left: 0, zIndex: 2, height: spreadsheetRowHeight, bgcolor: row.header ? 'rgba(0,255,65,0.13)' : undefined }}>{grid.startRow + row.sourceIndex + 1}</GridHeader>,
                ...Array.from({ length: maxColumns }, (_, columnIndex) => <Cell key={`${row.sourceIndex}-${columnIndex}-${virtualIndex}`} cell={row.cells[columnIndex]} header={row.header} locale={locale} timeZone={timeZone} />),
              ];
            })}
          </Box>
        </Box>
        {clippedColumns && <Alert severity="warning" variant="outlined" sx={{ m: 1 }}>The grid is clipped horizontally in this release: showing {maxColumns} columns.</Alert>}
      </Box>
    </Box>
  );
}

function GridHeader({ children, sticky = false, sx = {}, resizeWidth, onResize }: { children: ReactNode; sticky?: boolean; sx?: SxProps<Theme>; resizeWidth?: number; onResize?: (width: number) => void }) {
  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onResize || !resizeWidth) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerID = event.pointerId;
    const startX = event.clientX;
    const startWidth = resizeWidth;
    const target = event.currentTarget;
    target.setPointerCapture(pointerID);
    const move = (moveEvent: globalThis.PointerEvent) => {
      onResize(clampColumnWidth(startWidth + moveEvent.clientX - startX));
    };
    const done = () => {
      try {
        target.releasePointerCapture(pointerID);
      } catch {
        // Pointer capture can already be gone when the browser cancels the drag.
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done, { once: true });
    window.addEventListener('pointercancel', done, { once: true });
  }, [onResize, resizeWidth]);
  return (
    <Box sx={{ px: 0.75, py: 0.5, minHeight: spreadsheetRowHeight, borderRight: '1px solid', borderBottom: '1px solid', borderColor: 'rgba(132,150,126,0.22)', bgcolor: 'rgba(15,21,14,0.96)', color: 'primary.main', fontFamily: monoFontFamily, fontSize: 11, fontWeight: 900, position: sticky ? 'sticky' : undefined, top: sticky ? 0 : undefined, zIndex: sticky ? 2 : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...sx }}>
      {children}
      {onResize && (
        <Box
          onPointerDown={startResize}
          sx={{ position: 'absolute', top: 0, right: -3, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 8, '&:hover': { bgcolor: 'rgba(0,255,65,0.28)' } }}
          aria-label="Resize column"
          role="separator"
        />
      )}
    </Box>
  );
}

function Cell({ cell, header, locale, timeZone }: { cell?: SafeSpreadsheetCell; header?: boolean; locale: string; timeZone: string }) {
  const value = cellDisplayText(cell, locale, timeZone);
  const type = cell?.type || 'blank';
  const title = [value, type !== 'blank' ? `type: ${type}` : '', cell?.flags?.length ? `flags: ${cell.flags.join(', ')}` : ''].filter(Boolean).join('\n');
  return <Box title={title} sx={{ px: 0.75, py: 0.45, height: spreadsheetRowHeight, borderRight: '1px solid', borderBottom: '1px solid', borderColor: 'rgba(132,150,126,0.16)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: monoFontFamily, fontSize: 12, fontWeight: header ? 800 : 500, color: cellColor(type), textAlign: type === 'number' ? 'right' : 'left', bgcolor: header ? 'rgba(0,255,65,0.08)' : undefined }}>{value || '\u00a0'}</Box>;
}

function autoColumnWidths(rows: GridRow[], maxColumns: number, columns: SpreadsheetGridColumn[]): number[] {
  const widths = Array.from({ length: maxColumns }, (_, index) => Math.max(72, (columns[index]?.label || columnName(index)).length * 9 + 28));
  const sampleLimit = Math.min(rows.length, 250);
  for (let rowIndex = 0; rowIndex < sampleLimit; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let columnIndex = 0; columnIndex < maxColumns; columnIndex += 1) {
      const value = cellText(row?.cells[columnIndex]);
      if (!value) continue;
      const length = visualCellLength(value);
      const numeric = cellNumber(row?.cells[columnIndex]) !== null;
      const projected = Math.ceil(length * (numeric ? 7.2 : 8.1) + 30);
      widths[columnIndex] = Math.max(widths[columnIndex], projected);
    }
  }
  return widths.map(clampColumnWidth);
}

function visualCellLength(value: string): number {
  let width = 0;
  for (const char of value.slice(0, 160)) {
    width += char.charCodeAt(0) > 127 ? 1.6 : 1;
  }
  return width;
}

function clampColumnWidth(value: number): number {
  if (!Number.isFinite(value)) return 120;
  return Math.max(72, Math.min(360, Math.round(value)));
}

function gridModel(sheet: SafeSpreadsheetSheet | null, rowsData?: SafeSpreadsheetRowsResponse): SpreadsheetGridModel {
  const rawRows = rowsData?.chunk?.rows ?? [];
  const rows = rawRows.map((row, sourceIndex) => ({ sourceIndex, cells: Array.isArray(row) ? row : [] }));
  const maxColumns = Math.max(sheet?.column_count ?? 0, rows.reduce((max, row) => Math.max(max, row.cells.length), 0));
  const columns = normalizeColumns(sheet?.columns, maxColumns, sheet?.header?.detected ? rows[0]?.cells : undefined);
  return { sheetName: sheet?.name || rowsData?.chunk?.sheet_id || 'Sheet', startRow: rowsData?.chunk?.start_row ?? 0, rows, totalRows: sheet?.row_count ?? rows.length, columns };
}

function visibleGridModel(grid: SpreadsheetGridModel, mode: ViewerMode, searchText: string, headerEnabled: boolean, sortState: SortState, filterState: FilterState): SpreadsheetGridModel {
  if (mode !== 'interactive') {
    const safeRows = headerEnabled ? grid.rows.slice(1) : grid.rows;
    const needle = searchText.trim().toLowerCase();
    if (!needle) return { ...grid, rows: safeRows };
    return { ...grid, rows: safeRows.filter((row) => row.cells.some((cell) => cellText(cell).toLowerCase().includes(needle))) };
  }
  const [firstRow, ...restRows] = grid.rows;
  let dataRows = headerEnabled ? restRows : grid.rows;
  dataRows = dataRows.filter((row) => rowMatchesFilter(row, filterState));
  if (sortState) {
    const sortColumn = sortState.columnIndex;
    const direction = sortState.direction === 'asc' ? 1 : -1;
    dataRows = [...dataRows].sort((a, b) => compareCells(a.cells[sortColumn], b.cells[sortColumn]) * direction || a.sourceIndex - b.sourceIndex);
  }
  return { ...grid, rows: dataRows };
}

function normalizeColumns(columns: SafeSpreadsheetColumn[] | undefined, maxColumns: number, headerCells?: SafeSpreadsheetCell[]): SpreadsheetGridColumn[] {
  const out: SpreadsheetGridColumn[] = [];
  for (let index = 0; index < maxColumns; index += 1) {
    const source = columns?.find((column) => column.index === index);
    const headerLabel = cellText(headerCells?.[index]).trim();
    out.push({
      index,
      label: headerLabel || source?.label || columnName(index),
      inferredType: source?.inferred_type,
      confidence: source?.confidence,
    });
  }
  return out;
}

function rowMatchesFilter(row: GridRow, filter: FilterState): boolean {
  const cell = row.cells[filter.columnIndex];
  const text = cellText(cell).trim();
  const lower = text.toLowerCase();
  const needle = filter.value.trim().toLowerCase();
  switch (filter.operator) {
    case 'empty':
      return text === '';
    case 'not_empty':
      return text !== '';
    case 'equals':
      return lower === needle;
    case 'gt': {
      const value = cellNumber(cell);
      const target = Number(filter.value);
      return value !== null && Number.isFinite(target) && value > target;
    }
    case 'lt': {
      const value = cellNumber(cell);
      const target = Number(filter.value);
      return value !== null && Number.isFinite(target) && value < target;
    }
    case 'between': {
      const value = cellNumber(cell);
      const low = Number(filter.value);
      const high = Number(filter.secondValue);
      return value !== null && Number.isFinite(low) && Number.isFinite(high) && value >= Math.min(low, high) && value <= Math.max(low, high);
    }
    case 'contains':
    default:
      return !needle || lower.includes(needle);
  }
}

function nextSortState(current: SortState, columnIndex: number): SortState {
  if (!current || current.columnIndex !== columnIndex) return { columnIndex, direction: 'asc' };
  if (current.direction === 'asc') return { columnIndex, direction: 'desc' };
  return null;
}

function compareCells(a?: SafeSpreadsheetCell, b?: SafeSpreadsheetCell): number {
  const aNumber = cellNumber(a);
  const bNumber = cellNumber(b);
  if (aNumber !== null && bNumber !== null) return aNumber - bNumber;
  if (aNumber !== null) return -1;
  if (bNumber !== null) return 1;
  const aDate = cellDateSort(a);
  const bDate = cellDateSort(b);
  if (aDate !== null && bDate !== null) return aDate - bDate;
  if (aDate !== null) return -1;
  if (bDate !== null) return 1;
  const aText = cellText(a).toLocaleLowerCase();
  const bText = cellText(b).toLocaleLowerCase();
  if (!aText && bText) return 1;
  if (aText && !bText) return -1;
  return aText.localeCompare(bText, undefined, { numeric: true, sensitivity: 'base' });
}

function calculateRange(grid: SpreadsheetGridModel, state: CalculatorState, locale: string): CalculatorResult {
  const fromColumn = Math.min(state.fromColumn, state.toColumn);
  const toColumn = Math.max(state.fromColumn, state.toColumn);
  const fromRow = Math.min(state.fromRow, state.toRow);
  const toRow = Math.max(state.fromRow, state.toRow);
  const values: number[] = [];
  const textValues = new Set<string>();
  let scanned = 0;
  let nonEmpty = 0;
  for (const row of grid.rows) {
    const rowNumber = absoluteRowNumber(grid, row);
    if (rowNumber < fromRow || rowNumber > toRow) continue;
    for (let columnIndex = fromColumn; columnIndex <= toColumn; columnIndex += 1) {
      scanned++;
      const cell = row.cells[columnIndex];
      const text = cellText(cell).trim();
      if (text) {
        nonEmpty++;
        textValues.add(text);
      }
      const number = cellNumber(cell);
      if (number !== null) values.push(number);
    }
  }
  const ignored = Math.max(0, scanned - values.length);
  switch (state.fn) {
    case 'count_all':
      return { label: 'Count all', value: String(scanned), scanned, numeric: values.length, ignored };
    case 'count_numbers':
      return { label: 'Count numbers', value: String(values.length), scanned, numeric: values.length, ignored };
    case 'count_non_empty':
      return { label: 'Count non-empty', value: String(nonEmpty), scanned, numeric: values.length, ignored };
    case 'unique_count':
      return { label: 'Unique count', value: String(textValues.size), scanned, numeric: values.length, ignored };
    case 'average':
      return { label: 'Average', value: values.length ? formatNumber(values.reduce((sum, value) => sum + value, 0) / values.length, locale) : '—', scanned, numeric: values.length, ignored };
    case 'median':
      return { label: 'Median', value: values.length ? formatNumber(median(values), locale) : '—', scanned, numeric: values.length, ignored };
    case 'min':
      return { label: 'Min', value: values.length ? formatNumber(Math.min(...values), locale) : '—', scanned, numeric: values.length, ignored };
    case 'max':
      return { label: 'Max', value: values.length ? formatNumber(Math.max(...values), locale) : '—', scanned, numeric: values.length, ignored };
    case 'sum':
    default:
      return { label: 'Sum', value: values.length ? formatNumber(values.reduce((sum, value) => sum + value, 0), locale) : '—', scanned, numeric: values.length, ignored };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function formatNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 6 }).format(value);
}

function absoluteRowNumber(grid: SpreadsheetGridModel, row: GridRow): number {
  return grid.startRow + row.sourceIndex + 1;
}

function cellText(cell: SafeSpreadsheetCell | null | undefined): string {
  if (!cell || typeof cell !== 'object') return '';
  if (typeof cell.display === 'string' && cell.display !== '') return cell.display;
  return typeof cell.value === 'string' ? cell.value : '';
}

function cellDisplayText(cell: SafeSpreadsheetCell | null | undefined, locale: string, timeZone: string): string {
  if (!cell || typeof cell !== 'object') return '';
  if (cell.type === 'number') {
    const value = cellNumber(cell);
    if (value !== null) return formatNumber(value, locale);
  }
  if (cell.type === 'date_text' && cell.date_value) {
    const parsed = Date.parse(cell.date_value);
    if (Number.isFinite(parsed)) {
      return new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium', timeZone: timeZone || undefined }).format(new Date(parsed));
    }
  }
  return cellText(cell);
}

function cellNumber(cell: SafeSpreadsheetCell | null | undefined): number | null {
  if (!cell || cell.type !== 'number') return null;
  if (typeof cell.number_value === 'number' && Number.isFinite(cell.number_value)) return cell.number_value;
  const parsed = Number(cell.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cellDateSort(cell: SafeSpreadsheetCell | null | undefined): number | null {
  if (!cell || cell.type !== 'date_text' || !cell.date_value) return null;
  const parsed = Date.parse(cell.date_value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cellColor(type: string): string {
  switch (type) {
    case 'number':
      return 'tertiary.light';
    case 'boolean':
      return 'secondary.light';
    case 'date_text':
      return 'primary.light';
    case 'error':
      return 'error.light';
    case 'formula_text':
      return 'warning.light';
    default:
      return 'text.primary';
  }
}

function clampInteger(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, normalized));
}

function spreadsheetWarnings(workbookData?: SafeSpreadsheetWorkbookResponse, rowsData?: SafeSpreadsheetRowsResponse): unknown[] {
  return [
    ...(workbookData?.workbook?.warnings ?? []),
    ...(workbookData?.workbook?.sheets ?? []).flatMap((sheet) => sheet.warnings ?? []),
    ...(rowsData?.chunk?.truncated ? ['rows_truncated'] : []),
    ...(workbookData?.transport?.truncated || rowsData?.transport?.truncated ? ['remote_file_prefix_truncated'] : []),
  ];
}

function safeSpreadsheetStatusTitle(warningCount: number): string {
  const warningText = warningCount > 0 ? ` Parser warnings: ${warningCount}. Open the info details for the full list.` : '';
  return `ShellOrchestra renders inert typed cell values extracted by its protected spreadsheet parser. The browser does not execute formulas, macros, links, OLE objects, or embedded files.${warningText}`;
}

function spreadsheetWarningsTitle(workbookData?: SafeSpreadsheetWorkbookResponse, rowsData?: SafeSpreadsheetRowsResponse): string {
  const warnings = spreadsheetWarnings(workbookData, rowsData);
  if (warnings.length === 0) return '';
  return warnings.map((item) => {
    if (item && typeof item === 'object' && 'message' in item && typeof item.message === 'string') return item.message;
    return String(item);
  }).join('\n');
}

function spreadsheetDetailsText(filePath: string, workbookData: SafeSpreadsheetWorkbookResponse | undefined, activeSheet: SafeSpreadsheetSheet | null, rowsData: SafeSpreadsheetRowsResponse | undefined, headerEnabled: boolean, warningCount: number): string {
  const lines = [
    `File: ${filePath || '—'}`,
    `Format: ${workbookData?.workbook?.source_kind || '—'}`,
    `Sheets: ${workbookData?.workbook?.sheets?.length ?? 0}`,
    `Active sheet: ${activeSheet?.name || activeSheet?.id || '—'}`,
    `Rows: visible data is loaded in bounded chunks; current chunk has ${rowsData?.chunk?.rows?.length ?? 0} rows.`,
    `Columns: ${activeSheet?.column_count ?? 0}`,
    `Header: ${headerEnabled ? 'enabled' : 'disabled'}${activeSheet?.header?.confidence !== undefined ? `; confidence ${Math.round((activeSheet.header.confidence ?? 0) * 100)}%` : ''}${activeSheet?.header?.reason ? `; ${activeSheet.header.reason}` : ''}`,
    `Warnings: ${warningCount}`,
    `Transport bytes: ${workbookData?.transport?.decoded_bytes ? formatBytesCompact(workbookData.transport.decoded_bytes) : '—'}${workbookData?.transport?.truncated || rowsData?.transport?.truncated ? '; protected prefix only' : ''}`,
  ];
  const warnings = spreadsheetWarningsTitle(workbookData, rowsData);
  if (warnings) lines.push(`Warning details: ${warnings}`);
  return lines.join('\n');
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function basenameFromPath(path: string): string {
  return path.replace(/\\+/g, '/').replace(/\/+$/g, '').split('/').filter(Boolean).at(-1) || '';
}
