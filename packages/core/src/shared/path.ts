import { isAbsolute, relative, sep } from "node:path";

export const toPosix = (path: string): string => path.replaceAll("\\", "/");

export const isInside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export const safeRelativePath = (value: string): string | undefined => {
  if (
    /[\\:\u0000-\u001f]/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return undefined;
  }
  return value;
};
