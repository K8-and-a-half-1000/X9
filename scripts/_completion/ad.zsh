#compdef ad ad-backup ad-calendar ad-contacts ad-cookbook ad-docs ad-gallery ad-mail ad-mcp ad-memory ad-notes ad-personal ad-preset ad-research ad-sessions ad-signature ad-skills ad-tasks ad-theme ad-webhook
# Zsh tab-completion for the ad umbrella + sub-CLIs.
#
# Drop in any directory on $fpath, e.g.:
#     fpath=(/path/to/ad-ui/scripts/_completion $fpath)
#     autoload -U compinit; compinit
#
# Then `ad <tab>` completes subcommands; `ad mail <tab>`
# completes mail subcommands; `ad-mail <tab>` works the same.

_ad_scripts_dir() {
    local self="${(%):-%x}"
    while [[ -L "$self" ]]; do self="$(readlink "$self")"; done
    cd "${self:h}/.." && pwd
}

typeset -gA _ad_subs

_ad_refresh() {
    _ad_subs=()
    local dir="$(_ad_scripts_dir)"
    local py="$dir/../venv/bin/python"
    [[ -x "$py" ]] || py="$(command -v python3)"
    local f sub help_out commands
    for f in "$dir"/ad-*; do
        [[ -x "$f" ]] || continue
        case "$f" in
            *.bak|*.pyc|*.pre-*) continue ;;
        esac
        sub="${${f:t}#ad-}"
        help_out=$("$py" "$f" --help 2>/dev/null) || continue
        commands=$(echo "$help_out" | grep -oE '\{[a-z0-9_,-]+\}' | head -1 \
            | tr -d '{}' | tr ',' ' ')
        _ad_subs[$sub]="$commands"
    done
}

_ad() {
    [[ ${#_ad_subs} -eq 0 ]] && _ad_refresh

    local cmd="${words[1]}"

    if [[ "$cmd" == "ad" ]]; then
        if (( CURRENT == 2 )); then
            local -a subs=(${(k)_ad_subs} help)
            _describe 'subcommand' subs
            return
        fi
        local sub="${words[2]}"
        if [[ "$sub" == "help" ]] && (( CURRENT == 3 )); then
            local -a subs=(${(k)_ad_subs})
            _describe 'subcommand' subs
            return
        fi
        if (( CURRENT == 3 )); then
            local -a sc=(${(s/ /)_ad_subs[$sub]})
            _describe 'command' sc
            return
        fi
        return
    fi

    # ad-foo <tab>
    local sub="${cmd#ad-}"
    if (( CURRENT == 2 )); then
        local -a sc=(${(s/ /)_ad_subs[$sub]})
        _describe 'command' sc
        return
    fi
}

_ad "$@"
