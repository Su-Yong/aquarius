/** Return sorted labels without changing the caller's items. */
export function sortedLabels(items, enabled) {
  if (!enabled) {
    return [];
  } else {
    items.sort();
    return items.map((item) => item.trim());
  }
}
