# Bash completion for apollo.
#   source /path/to/apollo/completions/apollo.bash
# or copy it into /etc/bash_completion.d/ (or ~/.local/share/bash-completion/completions/).

_apollo() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    --provider)   COMPREPLY=($(compgen -W "ollama openai" -- "$cur")); return ;;
    --tool-mode)  COMPREPLY=($(compgen -W "auto native text" -- "$cur")); return ;;
    --cwd)        COMPREPLY=($(compgen -d -- "$cur")); return ;;
    --model)
      # Ask the running backend what it actually has, if it is up.
      local models
      models=$(apollo models 2>/dev/null)
      COMPREPLY=($(compgen -W "$models" -- "$cur"))
      return ;;
    --base-url|--context|--temperature|--max-tokens|--max-steps|--api-key|--resume|-p|--print|--prompt)
      return ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "\
--provider --base-url --model --tool-mode --context --temperature --max-tokens \
--max-steps --api-key --ask --auto-edit --yolo --read-only --continue --resume \
--cwd --no-stream --no-color --show-thinking --json --help --version" -- "$cur"))
    return
  fi

  COMPREPLY=($(compgen -W "doctor models init setup" -- "$cur"))
}

complete -F _apollo apollo
