export function isPackActivated(enabledPacks, packId, version) {
  return Array.isArray(enabledPacks) &&
    enabledPacks.some(item => item?.packId === packId && item?.version === version);
}

export function selectableRunPacks({ catalog, pack, enabledPacks } = {}) {
  const installed = catalog ?? (pack ? [pack] : []);
  // Older Graph responses omitted activation and exposed the installed catalog directly.
  if (enabledPacks === undefined) return installed;
  return installed.filter(item => isPackActivated(enabledPacks, item.id, item.version));
}
