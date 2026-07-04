// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import almalinuxIcon from './almalinux.svg';
import alpineLinuxIcon from './alpinelinux.svg';
import appleIcon from './apple.svg';
import archLinuxIcon from './archlinux.svg';
import centosIcon from './centos.svg';
import debianIcon from './debian.svg';
import endeavourOSIcon from './endeavouros.svg';
import fedoraIcon from './fedora.svg';
import gentooIcon from './gentoo.svg';
import kaliLinuxIcon from './kalilinux.svg';
import linuxIcon from './linux.svg';
import linuxMintIcon from './linuxmint.svg';
import manjaroIcon from './manjaro.svg';
import nixosIcon from './nixos.svg';
import opensuseIcon from './opensuse.svg';
import popOSIcon from './popos.svg';
import proxmoxIcon from './proxmox.svg';
import raspberryPiIcon from './raspberrypi.svg';
import redhatIcon from './redhat.svg';
import rockyLinuxIcon from './rockylinux.svg';
import suseIcon from './suse.svg';
import ubuntuIcon from './ubuntu.svg';
import windowsIcon from './windows.svg';

export type OSIconKey =
  | 'almalinux'
  | 'alpine'
  | 'apple'
  | 'arch'
  | 'centos'
  | 'debian'
  | 'endeavouros'
  | 'fedora'
  | 'gentoo'
  | 'kali'
  | 'linux'
  | 'linuxmint'
  | 'manjaro'
  | 'nixos'
  | 'opensuse'
  | 'popos'
  | 'proxmox'
  | 'raspberrypi'
  | 'redhat'
  | 'rocky'
  | 'suse'
  | 'ubuntu'
  | 'windows';

export type OSIconAsset = {
  key: OSIconKey;
  label: string;
  src: string;
};

export const osIconAssets: Record<OSIconKey, OSIconAsset> = {
  almalinux: { key: 'almalinux', label: 'AlmaLinux', src: almalinuxIcon },
  alpine: { key: 'alpine', label: 'Alpine Linux', src: alpineLinuxIcon },
  apple: { key: 'apple', label: 'macOS', src: appleIcon },
  arch: { key: 'arch', label: 'Arch Linux', src: archLinuxIcon },
  centos: { key: 'centos', label: 'CentOS', src: centosIcon },
  debian: { key: 'debian', label: 'Debian', src: debianIcon },
  endeavouros: { key: 'endeavouros', label: 'EndeavourOS', src: endeavourOSIcon },
  fedora: { key: 'fedora', label: 'Fedora', src: fedoraIcon },
  gentoo: { key: 'gentoo', label: 'Gentoo', src: gentooIcon },
  kali: { key: 'kali', label: 'Kali Linux', src: kaliLinuxIcon },
  linux: { key: 'linux', label: 'Linux', src: linuxIcon },
  linuxmint: { key: 'linuxmint', label: 'Linux Mint', src: linuxMintIcon },
  manjaro: { key: 'manjaro', label: 'Manjaro', src: manjaroIcon },
  nixos: { key: 'nixos', label: 'NixOS', src: nixosIcon },
  opensuse: { key: 'opensuse', label: 'openSUSE', src: opensuseIcon },
  popos: { key: 'popos', label: 'Pop!_OS', src: popOSIcon },
  proxmox: { key: 'proxmox', label: 'Proxmox VE', src: proxmoxIcon },
  raspberrypi: { key: 'raspberrypi', label: 'Raspberry Pi OS', src: raspberryPiIcon },
  redhat: { key: 'redhat', label: 'Red Hat', src: redhatIcon },
  rocky: { key: 'rocky', label: 'Rocky Linux', src: rockyLinuxIcon },
  suse: { key: 'suse', label: 'SUSE Linux Enterprise Server', src: suseIcon },
  ubuntu: { key: 'ubuntu', label: 'Ubuntu', src: ubuntuIcon },
  windows: { key: 'windows', label: 'Windows', src: windowsIcon },
};

const osIconAliases: Record<string, OSIconKey> = {
  alma: 'almalinux',
  almalinux: 'almalinux',
  'alma linux': 'almalinux',
  alpine: 'alpine',
  'alpine linux': 'alpine',
  apple: 'apple',
  darwin: 'apple',
  mac: 'apple',
  macos: 'apple',
  'mac os': 'apple',
  arch: 'arch',
  archlinux: 'arch',
  'arch linux': 'arch',
  centos: 'centos',
  debian: 'debian',
  endeavouros: 'endeavouros',
  endeavour: 'endeavouros',
  'endeavour os': 'endeavouros',
  'endeavour-os': 'endeavouros',
  fedora: 'fedora',
  gentoo: 'gentoo',
  kali: 'kali',
  kalilinux: 'kali',
  'kali linux': 'kali',
  linux: 'linux',
  linuxmint: 'linuxmint',
  'linux mint': 'linuxmint',
  manjaro: 'manjaro',
  nix: 'nixos',
  nixos: 'nixos',
  opensuse: 'opensuse',
  pop: 'popos',
  popos: 'popos',
  'pop os': 'popos',
  'pop! os': 'popos',
  'pop!_os': 'popos',
  proxmox: 'proxmox',
  pve: 'proxmox',
  'proxmox ve': 'proxmox',
  'open suse': 'opensuse',
  'open-suse': 'opensuse',
  raspberry: 'raspberrypi',
  raspberrypi: 'raspberrypi',
  'raspberry pi': 'raspberrypi',
  'raspberry pi os': 'raspberrypi',
  raspbian: 'raspberrypi',
  rhel: 'redhat',
  redhat: 'redhat',
  'red hat': 'redhat',
  'red hat enterprise linux': 'redhat',
  rocky: 'rocky',
  rockylinux: 'rocky',
  'rocky linux': 'rocky',
  sles: 'suse',
  sles_sap: 'suse',
  suse: 'suse',
  'suse linux enterprise server': 'suse',
  ubuntu: 'ubuntu',
  ol: 'linux',
  oraclelinux: 'linux',
  'oracle linux': 'linux',
  amzn: 'linux',
  amazonlinux: 'linux',
  'amazon linux': 'linux',
  win: 'windows',
  windows: 'windows',
};

const osIconContainsAliases: Array<[RegExp, OSIconKey]> = [
  [/\b(microsoft\s+)?windows\b/, 'windows'],
  [/\b(darwin|macos|mac\s+os)\b/, 'apple'],
  [/\balma\s*linux\b/, 'almalinux'],
  [/\balpine\s*linux\b/, 'alpine'],
  [/\barch\s*linux\b/, 'arch'],
  [/\bcentos\b/, 'centos'],
  [/\bdebian\b/, 'debian'],
  [/\bendeavour\s*os\b|\bendeavouros\b/, 'endeavouros'],
  [/\bfedora\b/, 'fedora'],
  [/\bgentoo\b/, 'gentoo'],
  [/\bkali\s*linux\b/, 'kali'],
  [/\blinux\s*mint\b|\blinuxmint\b/, 'linuxmint'],
  [/\bmanjaro\b/, 'manjaro'],
  [/\bnixos\b/, 'nixos'],
  [/\bopen\s*suse\b|\bopensuse\b/, 'opensuse'],
  [/\bpop!?(?:_|\s)*os\b|\bpopos\b/, 'popos'],
  [/\bproxmox(?:\s*ve)?\b|\bpve\b/, 'proxmox'],
  [/\braspberry\s*pi(\s*os)?\b/, 'raspberrypi'],
  [/\bred\s*hat\b|\brhel\b/, 'redhat'],
  [/\brocky\s*linux\b/, 'rocky'],
  [/\bsuse\b|\bsles(?:_sap)?\b/, 'suse'],
  [/\boracle\s*linux\b|\boraclelinux\b|\bol\b/, 'linux'],
  [/\bamazon\s*linux\b|\bamazonlinux\b|\bamzn\b/, 'linux'],
  [/\bubuntu\b/, 'ubuntu'],
];

export function resolveOSIcon(value: string | null | undefined): OSIconAsset {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-_./]+/g, ' ')
    .replace(/\s+/g, ' ');
  const exactMatch = osIconAliases[normalized];
  if (exactMatch) return osIconAssets[exactMatch];
  const containedMatch = osIconContainsAliases.find(([pattern]) => pattern.test(normalized));
  return osIconAssets[containedMatch?.[1] ?? 'linux'];
}
