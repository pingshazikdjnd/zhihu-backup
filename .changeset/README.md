# Changesets 使用说明

本仓库使用 [Changesets](https://github.com/changesets/changesets) 管理版本号与更新日志。

## 日常提交流程

1. 在功能或修复分支开发完成后，运行：

   ```bash
   pnpm changeset
   ```

2. 按提示选择受影响的包（如 `worker`；已配置 `fixed`，所有 workspace 包会统一同步升版）以及变更级别（`patch` / `minor` / `major`），填写中文变更说明。
3. 将生成的 `.changeset/*.md` 文件随 PR 一起提交并合并到 `main`。
4. 合并到 `main` 后，GitHub App 机器人会自动创建或更新 **Version Packages** PR；合并该 PR 后将自动打 `vX.Y.Z` tag、触发部署并发布 GitHub Release。

详情参见 [发版与部署指南](../docs/RELEASING.md)。
