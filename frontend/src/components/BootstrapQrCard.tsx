// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useState } from 'react';

const qrVersion = 5;
const qrSize = 17 + qrVersion * 4;
const dataCodewordCount = 108;
const eccCodewordCount = 26;
const qrByteCapacity = 106;
const quietZone = 4;

type Matrix = boolean[][];

type MatrixState = {
  modules: Matrix;
  reserved: Matrix;
};

type BootstrapQrCardProps = {
  qrUrl: string;
  expiresAt?: string | null;
  timeoutMinutes?: number;
};

function createEmptyMatrix(): MatrixState {
  const modules = Array.from({ length: qrSize }, () => Array.from({ length: qrSize }, () => false));
  const reserved = Array.from({ length: qrSize }, () => Array.from({ length: qrSize }, () => false));
  return { modules, reserved };
}

function setFunctionModule(state: MatrixState, x: number, y: number, dark: boolean) {
  if (x < 0 || y < 0 || x >= qrSize || y >= qrSize) return;
  state.modules[y][x] = dark;
  state.reserved[y][x] = true;
}

function drawFinderPattern(state: MatrixState, x: number, y: number) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      const inPattern = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inPattern && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setFunctionModule(state, xx, yy, dark);
    }
  }
}

function drawAlignmentPattern(state: MatrixState, centerX: number, centerY: number) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunctionModule(state, centerX + dx, centerY + dy, distance === 2 || distance === 0);
    }
  }
}

function reserveFormatAreas(state: MatrixState) {
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunctionModule(state, 8, i, false);
      setFunctionModule(state, i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(state, qrSize - 1 - i, 8, false);
  }
  for (let i = 8; i < 15; i += 1) {
    setFunctionModule(state, 8, qrSize - 15 + i, false);
  }
  setFunctionModule(state, 8, qrSize - 8, true);
}

function drawFunctionPatterns(state: MatrixState) {
  drawFinderPattern(state, 0, 0);
  drawFinderPattern(state, qrSize - 7, 0);
  drawFinderPattern(state, 0, qrSize - 7);
  drawAlignmentPattern(state, 30, 30);
  for (let i = 0; i < qrSize; i += 1) {
    if (!state.reserved[6][i]) setFunctionModule(state, i, 6, i % 2 === 0);
    if (!state.reserved[i][6]) setFunctionModule(state, 6, i, i % 2 === 0);
  }
  reserveFormatAreas(state);
}

function appendBits(target: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i -= 1) {
    target.push((value >>> i) & 1);
  }
}

function makeDataCodewords(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  if (bytes.length > qrByteCapacity) {
    throw new Error(`Pairing link is too long for the QR generator (${bytes.length}/${qrByteCapacity} bytes).`);
  }
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) {
    appendBits(bits, byte, 8);
  }
  const capacityBits = dataCodewordCount * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let codeword = 0;
    for (let j = 0; j < 8; j += 1) {
      codeword = (codeword << 1) | bits[i + j];
    }
    codewords.push(codeword);
  }
  for (let pad = 0xec; codewords.length < dataCodewordCount; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

function makeGaloisTables() {
  const exp = Array.from({ length: 255 }, () => 0);
  const log = Array.from({ length: 256 }, () => 0);
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = value;
    log[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  return { exp, log };
}

const gf = makeGaloisTables();

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return gf.exp[(gf.log[left] + gf.log[right]) % 255];
}

function makeGeneratorPolynomial(degree: number): number[] {
  let result = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = Array.from({ length: result.length + 1 }, () => 0);
    for (let j = 0; j < result.length; j += 1) {
      next[j] ^= result[j];
      next[j + 1] ^= gfMultiply(result[j], gf.exp[i]);
    }
    result = next;
  }
  return result;
}

function makeEccCodewords(data: number[]): number[] {
  const generator = makeGeneratorPolynomial(eccCodewordCount);
  const message = [...data, ...Array.from({ length: eccCodewordCount }, () => 0)];
  for (let i = 0; i < data.length; i += 1) {
    const factor = message[i];
    if (factor === 0) continue;
    for (let j = 1; j < generator.length; j += 1) {
      message[i + j] ^= gfMultiply(generator[j], factor);
    }
  }
  return message.slice(data.length);
}

function drawCodewords(state: MatrixState, codewords: number[]) {
  const bits = codewords.flatMap((codeword) => Array.from({ length: 8 }, (_, index) => (codeword >>> (7 - index)) & 1));
  let bitIndex = 0;
  let upward = true;
  for (let right = qrSize - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < qrSize; vertical += 1) {
      const y = upward ? qrSize - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (state.reserved[y][x]) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        const mask = (x + y) % 2 === 0;
        state.modules[y][x] = bit !== mask;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function makeFormatBits(): number {
  const errorCorrectionLow = 1;
  const mask = 0;
  const data = (errorCorrectionLow << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
}

function drawFormatBits(state: MatrixState) {
  const bits = makeFormatBits();
  const getBit = (index: number) => ((bits >>> index) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) setFunctionModule(state, 8, i, getBit(i));
  setFunctionModule(state, 8, 7, getBit(6));
  setFunctionModule(state, 8, 8, getBit(7));
  setFunctionModule(state, 7, 8, getBit(8));
  for (let i = 9; i < 15; i += 1) setFunctionModule(state, 14 - i, 8, getBit(i));
  for (let i = 0; i < 8; i += 1) setFunctionModule(state, qrSize - 1 - i, 8, getBit(i));
  for (let i = 8; i < 15; i += 1) setFunctionModule(state, 8, qrSize - 15 + i, getBit(i));
  setFunctionModule(state, 8, qrSize - 8, true);
}

function makeQrMatrix(text: string): Matrix {
  const state = createEmptyMatrix();
  drawFunctionPatterns(state);
  const data = makeDataCodewords(text);
  const ecc = makeEccCodewords(data);
  drawCodewords(state, [...data, ...ecc]);
  drawFormatBits(state);
  return state.modules;
}

export function QrCode({ value, label = 'QR code' }: { value: string; label?: string }) {
  const matrix = useMemo(() => makeQrMatrix(value), [value]);
  const viewBoxSize = qrSize + quietZone * 2;
  return (
    <Box
      component="svg"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      sx={{ display: 'block', width: 240, height: 240, bgcolor: '#fff', borderRadius: 2 }}
    >
      <rect width={viewBoxSize} height={viewBoxSize} fill="#fff" />
      {matrix.map((row, y) =>
        row.map((dark, x) => (dark ? <rect key={`${x}-${y}`} x={x + quietZone} y={y + quietZone} width="1" height="1" fill="#000" /> : null)),
      )}
    </Box>
  );
}

function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function BootstrapQrCard({ qrUrl, expiresAt, timeoutMinutes }: BootstrapQrCardProps) {
  const expiryTime = useMemo(() => (expiresAt ? new Date(expiresAt).getTime() : undefined), [expiresAt]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiryTime) return undefined;
    const intervalID = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalID);
  }, [expiryTime]);

  const remainingMs = expiryTime === undefined ? undefined : expiryTime - now;
  const isExpired = remainingMs !== undefined && remainingMs <= 0;

  try {
    return (
      <Card variant="outlined">
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ alignItems: { xs: 'stretch', md: 'center' } }}>
            <Box sx={{ alignSelf: { xs: 'center', md: 'flex-start' } }}>
              <QrCode value={qrUrl} label="Phone pairing QR code" />
            </Box>
            <Stack spacing={1.5} sx={{ flexGrow: 1 }}>
              <Typography variant="h5" sx={{ fontWeight: 800 }}>First-start phone pairing</Typography>
              <Typography color="text.secondary">
                Scan this QR code with the phone that will become the first approved device. The desktop stays in setup mode until phone registration succeeds.
              </Typography>
              {remainingMs !== undefined && (
                <Alert severity={isExpired ? 'error' : 'warning'}>
                  {isExpired ? 'FIRST PHONE SETUP IS CLOSED.' : `THIS QR CODE EXPIRES IN ${formatRemaining(remainingMs)}.`}
                </Alert>
              )}
              {expiresAt && <Typography color="text.secondary">Expires at {new Date(expiresAt).toLocaleString()}.</Typography>}
              <Alert severity="info">The pairing link is encoded only in this QR code. Desktop navigation is hidden until the first phone is registered.</Alert>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    );
  } catch (error) {
    return <Alert severity="error">CANNOT SHOW THE QR CODE. Ask the ShellOrchestra administrator to check the public app URL. Details: {error instanceof Error ? error.message : 'unknown QR error'}</Alert>;
  }
}
