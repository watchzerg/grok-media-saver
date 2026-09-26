# 当前只有工具链基座；新增测试或应用边界时将相应验证加入 gate-core/gate-full。
set shell := ["bash", "-cu"]
set positional-arguments := true

check-toolchain:
    mise exec -- bun scripts/assert-bun-runtime.mjs

install:
    mise install --locked bun
    mise exec -- bun ci

typecheck:
    mise exec -- bun run tsc --noEmit

test *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    scope="${1:-all}"
    case "$scope" in
        core)
            shift
            if [[ $# -gt 0 && "$1" != -* ]]; then
                exec mise exec -- bun test "$@"
            fi
            exec mise exec -- bun test ./tests/core "$@"
            ;;
        all)
            if [[ $# -gt 0 ]]; then shift; fi
            exec mise exec -- bun test "$@"
            ;;
        *) exec mise exec -- bun test "$@" ;;
    esac

gate-core:
    just check-toolchain
    just typecheck
    just test core
    mise exec -- bun run biome ci

gate-full:
    just gate-core
    just test tests/cli

env-facts:
    @mise exec -- bun -e 'console.log(JSON.stringify({bun: Bun.version, missing: []}))'

fmt *FILES:
    #!/usr/bin/env bash
    set -euo pipefail
    exec mise exec -- bun run biome check --write "$@"
