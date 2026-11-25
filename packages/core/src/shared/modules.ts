import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveModule } from "import-meta-resolve";

export const importProjectModule = async (
  specifier: string,
  baseDirectory: string,
): Promise<unknown> => {
  const parent = pathToFileURL(
    path.join(path.resolve(baseDirectory), "__aquarius_module_resolver__.mjs"),
  ).href;
  const resolved = resolveModule(
    path.isAbsolute(specifier) || path.win32.isAbsolute(specifier)
      ? pathToFileURL(specifier).href
      : specifier,
    parent,
  );
  const namespace = await import(resolved);
  return Object.hasOwn(namespace, "default") ? namespace.default : namespace;
};
