# 当前只有工具链基座；新增应用边界时将对应 gate 加入 gate-plan/full。
set shell := ["bash", "-cu"]
set positional-arguments := true

check-toolchain:
    mise exec -- bun scripts/assert-bun-runtime.mjs

install:
    mise install --locked bun
    mise exec -- bun ci

typecheck:
    @echo "typecheck 尚未配置：仓库目前没有 TypeScript 源码" >&2
    @exit 1

test SCOPE *ARGS:
    @echo "test 尚未配置：仓库目前没有应用测试" >&2
    @exit 1

gate-plan:
    @echo '{"core":"gate-core","full":["gate-core"],"defer_to_final":[]}'

gate-core:
    just check-toolchain
    mise exec -- bun run biome ci

gate-artifact:
    @echo "gate-artifact 尚未配置：仓库目前没有构建产物" >&2
    @exit 1

gate-database:
    @echo "gate-database 尚未配置：仓库目前没有数据库代码" >&2
    @exit 1

gate-browser:
    @echo "gate-browser 尚未配置：仓库目前没有浏览器代码" >&2
    @exit 1

gate-system:
    @echo "gate-system 尚未配置：仓库目前没有系统集成代码" >&2
    @exit 1

gate-full:
    just gate-core

env-facts:
    @mise exec -- bun -e 'console.log(JSON.stringify({bun: Bun.version, missing: []}))'

fmt *FILES:
    #!/usr/bin/env bash
    set -euo pipefail
    exec mise exec -- bun run biome check --write "$@"
