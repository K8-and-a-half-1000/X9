#compdef x9 x9-backup x9-calendar x9-contacts x9-cookbook x9-docs x9-gallery x9-mail x9-mcp x9-memory x9-notes x9-personal x9-preset x9-research x9-sessions x9-signature x9-skills x9-tasks x9-theme x9-webhook
# Zsh tab-completion for the x9 umbrella + sub-CLIs.
#
# Drop in any directory on $fpath, e.g.:
#     fpath=(/path/to/x9-ui/scripts/_completion $fpath)
#     autoload -U compinit; compinit
#
# Then `x9 <tab>` completes subcommands; `x9 mail <tab>`
# completes mail subcommands; `x9-mail <tab>` works the same.

_x9_scripts_dir() {
    local self="${(%):-%x}"
    while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
    cd "${self:h}/.." && pwd
}

typeset -gA _x9_subs

_x9_refresh() {
    _x9_subs=()
    local dir="$(_x9_scripts_dir)"
    local py="$dir/../venv/bin/python"
    [[ -x "$py" ]] || py="$(command -v python3)"
    local f sub help_out commands
    for f in "$dir"/x9-*; do
        [[ -x "$f" ]] || continue
        case "$f" in
            *.bak|*.pyc|*.pre-*) continue ;;
        esac
        sub="${${f:t}#x9-}"
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _x9_subs[$sub]="$commands"
    done
}

_x9() {
    [[ ${#_x9_subs} -eq 0 ]] && _x9_refresh

    local cmd="${words[1]}"

    if [[ "$cmd" == "x9" ]]; then
        if (( CURRENT == 2 )); then
            local -a subs=(${(k)_x9_subs} help)
            _describe 'subcommand' subs
            return
        fi
        local sub="${words[2]}"
        if [[ "$sub" == "help" ]] && (( CURRENT == 3 )); then
            local -a subs=(${(k)_x9_subs})
            _describe 'subcommand' subs
            return
        fi
        if (( CURRENT == 3 )); then
            local -a sc=(${(s/ /)_x9_subs[$sub]})
            _describe 'command' sc
            return
        fi
        return
    fi

    # x9-foo <tab>
    local sub="${cmd#x9-}"
    if (( CURRENT == 2 )); then
        local -a sc=(${(s/ /)_x9_subs[$sub]})
        _describe 'command' sc
        return
    fi
}

_x9 "$@"
