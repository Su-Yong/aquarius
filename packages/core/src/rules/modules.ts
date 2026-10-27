import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveModule } from "import-meta-resolve";

const hasLocalPackage = async (specifier: string, baseDirectory: string): Promise<boolean> => {
  const parts = specifier.split("/");
  const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  let directory = path.resolve(baseDirectory);
  for (;;) {
    try {
      await access(path.join(directory, "node_modules", name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      if (JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).name === name) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
};

export const importProjectModule = async (
  specifier: string,
  baseDirectory: string,
  fallback?: unknown,
): Promise<unknown> => {
  const parent = pathToFileURL(path.join(path.resolve(baseDirectory), "__aquarius_module_resolver__.mjs")).href;
  let resolved: string;
  try {
    resolved = resolveModule(
      path.isAbsolute(specifier) || path.win32.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier,
      parent,
    );
  } catch (error) {
    const isPackage = !specifier.startsWith(".") && !specifier.includes(":") && !path.isAbsolute(specifier);
    if (
      fallback !== undefined
      && isPackage
      && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
      && !(await hasLocalPackage(specifier, baseDirectory))
    ) {
      return fallback;
    }
    throw error;
  }
  const namespace = await import(resolved);
  return Object.hasOwn(namespace, "default") ? namespace.default : namespace;
};
