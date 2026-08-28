export function isRootPath(path: string): boolean {
  if (path === "/") return true;
  return /^[a-zA-Z]:\/?$/.test(path);
}

export function parentPath(current: string): string {
  // Windows drive paths root at "C:/"; POSIX paths root at "/".
  const drive = current.match(/^[a-zA-Z]:/);
  if (drive) {
    const trimmed = current.replace(/\/+$/, "");
    const cut = trimmed.lastIndexOf("/");
    const parent = cut >= 2 ? trimmed.slice(0, cut) : trimmed.slice(0, 2);
    return /[a-zA-Z]:$/.test(parent) ? `${parent}/` : parent;
  }
  if (current === "/") return "/";
  const trimmed = current.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function joinPath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  if (/^[a-zA-Z]:\/?$/.test(dir)) {
    return `${dir.replace(/\/$/, "")}/${name}`;
  }
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function breadcrumbSegments(
  current: string
): Array<{ label: string; path: string }> {
  const segments: Array<{ label: string; path: string }> = [];
  const drive = current.match(/^[a-zA-Z]:/);
  if (drive) {
    let accumulated = "";
    for (const part of current.split("/").filter(Boolean)) {
      accumulated = accumulated ? `${accumulated}/${part}` : `${part}/`;
      segments.push({ label: part, path: accumulated });
    }
    if (segments.length === 0) {
      segments.push({ label: "/", path: "/" });
    }
    return segments;
  }
  segments.push({ label: "/", path: "/" });
  let accumulated = "";
  for (const part of current.split("/").filter(Boolean)) {
    accumulated += `/${part}`;
    segments.push({ label: part, path: accumulated });
  }
  return segments;
}
