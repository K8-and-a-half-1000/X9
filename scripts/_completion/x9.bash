#!/usr/bin/env bash
# Tab-completion for the `x9` umbrella + every `x9-*` CLI.
#
# Source from your shell rc:
#     source /path/to/x9-ui/scripts/_completion/x9.bash
#
# Or wire it once per machine:
#     sudo install -m 644 x9.bash /etc/bash_completion.d/x9
#
# What it does:
#   - On the first word after `x9`, complete with the list of
#     subcommands (`mail`, `calendar`, ...).
#   - On subsequent words, complete with the subcommand's first-token
#     subcommands (`list`, `show`, ...) which we cache by parsing the
#     tool's own --help output. Updates lazily; refresh by running
#     `_x9_refresh_cache`.
#   - Same completion works for the individual `x9-foo` scripts.

_x9_scripts_dir() {
    # Resolve the scripts/ dir from the script that sources us. We assume
    # the user sourced the file directly out of scripts/_completion/.
    local self="${BASH_SOURCE[0]}"
    while [ -L "$self" ]; do self=$(readlink "$self"); done
    cd "$(dirname "$self")/.." && pwd
}

declare -A _X9_SUBS_CACHE=()

_x9_refresh_cache() {
    local dir="$(_x9_scripts_dir)"
    _X9_SUBS_CACHE=()
    # Prefer the project venv's Python so deps (bcrypt, sqlalchemy, ...)
    # resolve. Falls back to system `python3` for container installs.
    local py="$dir/../venv/bin/python"
    [ -x "$py" ] || py="$(command -v python3)"
    local f
    for f in "$dir"/x9-*; do
        [ -x "$f" ] || continue
        case "$f" in *.bak|*.pyc|*.pre-*) continue ;; esac
        local name="$(basename "$f")"
        local sub="${name#x9-}"
        local help_out
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        local commands
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _X9_SUBS_CACHE[$sub]="$commands"
    done
}

_x9_complete() {
    [ ${#_X9_SUBS_CACHE[@]} -eq 0 ] && _x9_refresh_cache

    local cur="${COMP_WORDS[COMP_CWORD]}"
    local cmd="${COMP_WORDS[0]}"

    # `x9 <tab>` → list every subcommand
    if [ "$cmd" = "x9" ]; then
        if [ "$COMP_CWORD" -eq 1 ]; then
            local subs="${!_X9_SUBS_CACHE[@]} help"
            COMPREPLY=($(compgen -W "$subs" -- "$cur"))
            return 0
        fi
        # `x9 foo <tab>` — complete with foo's own subcommands
        local sub="${COMP_WORDS[1]}"
        # `x9 help <tab>` lists every subcommand
        if [ "$sub" = "help" ] && [ "$COMP_CWORD" -eq 2 ]; then
            COMPREPLY=($(compgen -W "${!_X9_SUBS_CACHE[*]}" -- "$cur"))
            return 0
        fi
        if [ "$COMP_CWORD" -eq 2 ]; then
            COMPREPLY=($(compgen -W "${_X9_SUBS_CACHE[$sub]}" -- "$cur"))
            return 0
        fi
        return 0
    fi

    # Direct `x9-foo <tab>` (no umbrella)
    local sub="${cmd#x9-}"
    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=($(compgen -W "${_X9_SUBS_CACHE[$sub]}" -- "$cur"))
        return 0
    fi
}

# Register the completion for every x9-* script + the umbrella.
complete -F _x9_complete x9
for f in "$(_x9_scripts_dir)"/x9-*; do
    [ -x "$f" ] || continue
    case "$f" in *.bak|*.pyc|*.pre-*) continue ;; esac
    complete -F _x9_complete "$(basename "$f")"
done
