import { isAbsolute, relative, sep } from "node:path";

const UNSUPPORTED_PATH_CHARACTERS = /[\\:\u0000-\u001f]/u;

export const toPosix = (path: string): string => path.replaceAll("\\", "/");

export const isInside = (parent: string, child: string): boolean => {
  const relativePath = relative(parent, child);
  const staysWithinParent =
    relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  return staysWithinParent;
};

export const safeRelativePath = (value: string): string | undefined => {
  if (UNSUPPORTED_PATH_CHARACTERS.test(value) || hasInvalidPathSegment(value)) {
    return undefined;
  }
  return value;
};

const hasInvalidPathSegment = (path: string): boolean => {
  const segments = path.split("/");
  return segments.some((segment) => {
    const isEmptyOrDotSegment = segment === "" || segment === "." || segment === "..";
    return isEmptyOrDotSegment;
  });
};
