/** Builds a folder tree from paths, folding chains of single folders into one row (a/b/c). */
export function buildFolderTree<T extends { path: string }>(items: T[]): FolderNode<T> {
  const root: FolderNode<T> = { name: '', path: '', folders: new Map(), files: [] };
  for (const item of items) {
    const parts = item.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let next = node.folders.get(name);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join('/'), folders: new Map(), files: [] };
        node.folders.set(name, next);
      }
      node = next;
    }
    node.files.push(item);
  }
  const compact = (n: FolderNode<T>): FolderNode<T> => {
    for (const [key, child] of n.folders) n.folders.set(key, compact(child));
    if (n.path && n.files.length === 0 && n.folders.size === 1) {
      const only = [...n.folders.values()][0];
      return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return compact(root);
}

export interface FolderNode<T> {
  name: string;
  path: string;
  folders: Map<string, FolderNode<T>>;
  files: T[];
}
