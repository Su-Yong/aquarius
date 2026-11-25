# Aquarius

## Releases

Record package changes with `pnpm changeset`. Run `pnpm version-packages` to apply the package versions and changelogs, then commit those changes on `master`.

Run `pnpm release` to publish the workspace packages and create the Aquarius Git tag and GitHub release. The project bump follows the largest package bump since the previous Aquarius tag. Authenticate to npm before publishing. For GitHub, use `gh auth login` or set `GITHUB_TOKEN`.

Preview a prepared release with `pnpm release --ci --dry-run`.
