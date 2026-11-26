# Changesets 使用说明

本仓库默认由 `.github/scripts/auto-changeset.mjs` 根据合并到 `main` 的 PR 标题或提交前缀自动生成变更说明，**日常提 PR 无需手动执行 `changeset`**。

## 自动识别规则

- `feat:` → `minor`
- `fix:` / `perf:` / `revert:` → `patch`
- `feat!:` 或正文含 `BREAKING CHANGE:` → `major`
- `docs:` / `chore:` / `ci:` / `test:` / `style:` / `refactor:` → 不触发发版

## 如需手写自定义说明（可选）

1. 在分支运行 `pnpm changeset` 选择受影响的包（如 `worker`）并填写自定义说明。
2. 将 `.changeset/*.md` 一并提交；存在手动 changeset 的提交不会重复自动生成。

详情参见 [发版与自动部署指南](../docs/RELEASING.md)。
