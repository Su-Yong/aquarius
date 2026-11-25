import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { diff } from "semver";

const incrementForChanges = () => {
  const tag = execFileSync("git", ["describe", "--tags", "--match", "v[0-9]*", "--abbrev=0"], {
    encoding: "utf8",
  }).trim();

  const increments = readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => {
      const file = `packages/${name}/package.json`;
      const current = JSON.parse(readFileSync(file, "utf8"));
      if (current.private) return null;

      const previous = spawnSync("git", ["show", `${tag}:${file}`], { encoding: "utf8" });
      if (previous.status !== 0) return "minor";
      return diff(JSON.parse(previous.stdout).version, current.version);
    });

  return ["major", "minor", "patch"].find(
    (increment) => increments.includes(increment) || increments.includes(`pre${increment}`),
  ) ?? (increments.includes("prerelease") ? "patch" : null);
};

const args = process.argv.slice(2);
if ((!args[0] || args[0].startsWith("-")) && !args.includes("--no-increment")) {
  const increment = incrementForChanges();
  if (!increment) {
    console.log("Package versions match the latest Aquarius release tag.");
    process.exit(0);
  }
  args.unshift(increment);
}

const env = { ...process.env };
if (!env.GITHUB_TOKEN) {
  const auth = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (auth.status === 0) env.GITHUB_TOKEN = auth.stdout.trim();
}

const release = spawnSync("release-it", args, { env, stdio: "inherit" });
if (release.error) throw release.error;
process.exitCode = release.status ?? 1;
