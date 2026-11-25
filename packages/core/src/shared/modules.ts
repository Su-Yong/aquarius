import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolve as resolveModule } from "import-meta-resolve";

export const importProjectModule = async (
  specifier: string,
  baseDirectory: string,
): Promise<unknown> => {
  const resolverPath = path.join(
    path.resolve(baseDirectory),
    "__aquarius_module_resolver__.mjs",
  );
  const parentURL = pathToFileURL(resolverPath).href;

  const resolutionSpecifier =
    path.isAbsolute(specifier) || path.win32.isAbsolute(specifier)
      ? pathToFileURL(specifier).href
      : specifier;
  const resolvedSpecifier = resolveModule(resolutionSpecifier, parentURL);

  const namespace = await import(resolvedSpecifier);
  return Object.hasOwn(namespace, "default") ? namespace.default : namespace;
};
