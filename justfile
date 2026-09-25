# 当前只有工具链基座；新增应用边界时将对应 gate 加入 gate-plan/full。
set shell := ["bash", "-cu"]
set positional-arguments := true

check-toolchain:
    mise exec -- bun scripts/assert-bun-runtime.mjs

install:
    mise install --locked bun
    mise exec -- bun ci

typecheck:
    mise exec -- bun run tsc --noEmit

test SCOPE *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    scope="$1"
    shift
    case "$scope" in
        core)
            if [[ $# -gt 0 && "$1" != -* ]]; then
                exec mise exec -- bun test "$@"
            fi
            exec mise exec -- bun test ./tests/core "$@"
            ;;
        *) echo "未知测试 scope: $scope" >&2; exit 2 ;;
    esac

gate-plan:
    @echo '{"core":"gate-core","full":["gate-core"],"defer_to_final":[]}'

gate-core:
    just check-toolchain
    just typecheck
    mise exec -- bun run biome ci

gate-full:
    just gate-core

env-facts:
    @mise exec -- bun -e 'console.log(JSON.stringify({bun: Bun.version, missing: []}))'

fmt *FILES:
    #!/usr/bin/env bash
    set -euo pipefail
    exec mise exec -- bun run biome check --write "$@"
