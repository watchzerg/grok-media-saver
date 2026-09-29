# 当前 gate-core 包含快速核心测试；gate-full 另运行真实 CLI/隔离 DB 边界测试。
set shell := ["bash", "-cu"]
set positional-arguments := true

check-toolchain:
    mise exec -- bun scripts/assert-bun-runtime.mjs

install:
    mise install --locked bun
    mise exec -- bun ci

# 在前台运行源码 CLI，原样转发参数与退出码。
run *ARGS:
    @exec mise exec -- bun src/cli.ts "$@"

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
