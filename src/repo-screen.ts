import { RepoScreening, RepoTreeItem, SearchRepo } from "./types.js";
import { englishHeuristic } from "./util.js";

function hasPath(tree: RepoTreeItem[], matcher: (path: string) => boolean): boolean {
  return tree.some((item) => matcher(item.path));
}

export function screenRepository(repo: SearchRepo, tree: RepoTreeItem[], readme?: string): RepoScreening {
  const reasons: string[] = [];
  const lowerPaths = tree.map((item) => item.path.toLowerCase());
  const hasPackageJson = lowerPaths.includes("package.json");
  const hasPyProject = lowerPaths.includes("pyproject.toml");
  const hasRequirements = lowerPaths.some((path) => path.startsWith("requirements") && path.endsWith(".txt"));
  const hasEnvironmentYaml = lowerPaths.includes("environment.yml") || lowerPaths.includes("environment.yaml");
  const hasDockerfile = lowerPaths.includes("dockerfile") || lowerPaths.some((path) => /(^|\/)dockerfile(\.[^/]+)?$/i.test(path));
  const hasTests = hasPath(tree, (path) => /(^|\/)(tests?|__tests__|spec|specs)(\/|$)/i.test(path));
  const hasBuildHints = Boolean(readme && /(install|setup|usage|run|test|docker)/i.test(readme));
  const readmeEnglishLikely = Boolean(readme && englishHeuristic(readme));

  let packageManager: string | undefined;
  if (hasPackageJson) packageManager = "npm-compatible";
  if (hasPyProject) packageManager = "pyproject";
  if (!packageManager && hasRequirements) packageManager = "pip";
  if (!packageManager && hasEnvironmentYaml) packageManager = "conda";

  if (repo.isArchived) reasons.push("repo is archived");
  if (!packageManager) reasons.push("missing standard package manager manifest");
  if (!hasTests) reasons.push("tests not detected");
  if (!readmeEnglishLikely) reasons.push("README does not look English enough");
  if (!hasBuildHints) reasons.push("README lacks clear build or test hints");

  return {
    accepted: reasons.length === 0,
    reasons,
    packageManager,
    hasDockerfile,
    hasTests,
    readmeEnglishLikely,
    hasBuildHints,
    treeCount: tree.length,
    interestingPaths: tree
      .map((item) => item.path)
      .filter((path) => /(^|\/)(package\.json|pyproject\.toml|requirements.*\.txt|environment\.ya?ml|dockerfile|docker-compose\.ya?ml|compose\.ya?ml|tests?|__tests__|spec|specs|readme)/i.test(path))
      .slice(0, 50),
  };
}
