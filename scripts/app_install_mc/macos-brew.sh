#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

install_shellorchestra_mc_skin() {
  skin_name=shellorchestra-yadt256-defbg
  skin_dir=${XDG_DATA_HOME:-"$HOME/.local/share"}/mc/skins
  skin_file=$skin_dir/$skin_name.ini
  mkdir -p "$skin_dir"
  cat > "$skin_file" <<'SHELLORCHESTRA_MC_SKIN'
# yadt256-defbg (Yet Another Dark Theme, 256 colors, default background)
# Based on modarin256-defbg of Oliver Lange <modarin@bloody.in-berlin.de>
#
# The skin looks good only if you have some sort of a "dark background".
# It can be set by the color schema of your terminal (e.g. Green-On-Black)
# or as underlying windows in the transparent mode. For a "light background",
# I'd use a version of the skin with a static background color (yadt256)

[skin]
    description = ShellOrchestra yadt256 defbg, 256 colors
    256colors = true

[Lines]
    horiz = ─
    vert = │
    lefttop = ┌
    righttop = ┐
    leftbottom = └
    rightbottom = ┘
    topmiddle = ┬
    bottommiddle = ┴
    leftmiddle = ├
    rightmiddle = ┤
    cross = ┼
    dhoriz = ─
    dvert = │
    dlefttop = ┌
    drighttop = ┐
    dleftbottom = └
    drightbottom = ┘
    dtopmiddle = ┬
    dbottommiddle = ┴
    dleftmiddle = ├
    drightmiddle = ┤

[core]
    _default_ = color250;color234
    selected = color16;color46
    marked = color228;color239;bold
    markselect = color16;color46;bold
    gauge = color16;color46
    input = color187;color235;bold
    inputmark = color228;blue;bold
    inputunchanged = color144;color235;bold
    commandlinemark = color228;blue;bold
    reverse = color16;color46;bold
    header = color46;;bold
    disabled = color246;color239
    #inputhistory =
    #commandhistory =
    shadow = color239;black

[dialog]
    _default_ = color252;color239
    dhotnormal = color214
    dfocus = color16;color46;bold
    dhotfocus = color16;color46
    dtitle = color180;;bold

[error]
    _default_ = color230;color52
    errdfocus = color254;blue;bold
    errdhotnormal = color203;color52
    errdhotfocus = color203;blue;bold
    errdtitle = color227;;bold

[filehighlight]
    directory = color144;;bold
    executable = color114
    symlink = color45
    hardlink =
    stalelink = color203
    device = color170
    special = color142
    core = color197
    temp = color245
    archive = color172
    doc = color153
    source = color109
    media = color141
    graph = color216
    database = color103

[menu]
    _default_ = color252;color239
    menusel = color16;color46
    menuhot = color214
    menuhotsel = color16;color46
    menuinactive = color252

[popupmenu]
    _default_ = color252;color234
    menusel = color16;color46
    menutitle = color180;;bold

[buttonbar]
    button = color250;color236
    hotkey = color46;color238;bold

[statusbar]
    _default_ = color16;color46

[help]
    _default_ = color252;color239
    helpitalic = color114;;bold
    helpbold = color180;;bold
    helplink = color45
    helpslink = color228;blue;bold
    helptitle = color180;;bold

[editor]
    _default_ = color250;default
    editbold = color228;;bold
    editmarked = color16;color46;bold
    editwhitespace = color56;color234
    editnonprintable = ;black
    editlinestate = color66;color235
    bookmark = ;color239
    bookmarkfound = ;color239;bold
    editrightmargin = ;color235;bold

[viewer]
    _default_ = color250;default
    viewbold = ;;bold
    viewunderline = ;;underline
    viewselected = color16;color46;bold

[diffviewer]
    changedline = color231;color29
    changednew = color232;color78
    changed = color231;color39
    added = color232;color81
    removed = ;color234
    error = color231;color160

[widget-panel]
    sort-up-char = ↑
    sort-down-char = ↓
    hiddenfiles-show-char = •
    hiddenfiles-hide-char = ○
    history-prev-item-char = <
    history-next-item-char = >
    history-show-list-char = ^

[widget-scrollbar]
    first-vert-char = ↑
    last-vert-char = ↓
    first-horiz-char = <
    last-horiz-char = >
    current-char = ■
    background-char = ▒
SHELLORCHESTRA_MC_SKIN

  # Activate the ShellOrchestra MC skin only during installation. Runtime launches
  # intentionally respect the user's later Midnight Commander preferences.
  config_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/mc
  config_file=$config_dir/ini
  mkdir -p "$config_dir"
  if [ -f "$config_file" ] && grep -q '^skin=' "$config_file"; then
    tmp_file=$(mktemp)
    sed 's/^skin=.*/skin=shellorchestra-yadt256-defbg/' "$config_file" > "$tmp_file"
    cat "$tmp_file" > "$config_file"
    rm -f "$tmp_file"
  else
    {
      printf '\n[Midnight-Commander]\n'
      printf 'skin=shellorchestra-yadt256-defbg\n'
      printf 'use_internal_edit=1\n'
    } >> "$config_file"
  fi
  if grep -q '^use_internal_edit=' "$config_file"; then
    tmp_file=$(mktemp)
    sed 's/^use_internal_edit=.*/use_internal_edit=1/' "$config_file" > "$tmp_file"
    cat "$tmp_file" > "$config_file"
    rm -f "$tmp_file"
  else
    {
      printf '\n[Midnight-Commander]\n'
      printf 'use_internal_edit=1\n'
    } >> "$config_file"
  fi
}

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ENV_HINTS=1

if command -v mc >/dev/null 2>&1; then
  install_shellorchestra_mc_skin
  printf '{"ok":true,"app":"%s","manager":"%s","already_installed":true}\n' "mc" "brew"
  exit 0
fi

if command -v brew >/dev/null 2>&1; then
  shellorchestra_brew=brew
elif [ -x /opt/homebrew/bin/brew ]; then
  shellorchestra_brew=/opt/homebrew/bin/brew
elif [ -x /usr/local/bin/brew ]; then
  shellorchestra_brew=/usr/local/bin/brew
else
  echo "Homebrew was not found on this server. Install Homebrew or choose a server profile with a supported package manager." >&2
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  if ! curl --silent --show-error --fail --head --location --connect-timeout 5 --max-time 12 https://formulae.brew.sh/api/formula.jws.json >/dev/null; then
    echo "Homebrew cannot reach formulae.brew.sh from this server. Check DNS and outbound HTTPS access, then try installing Midnight Commander again." >&2
    exit 1
  fi
fi

"$shellorchestra_brew" install midnight-commander >&2
install_shellorchestra_mc_skin
printf '{"ok":true,"app":"%s","manager":"%s"}\n' "mc" "brew"
