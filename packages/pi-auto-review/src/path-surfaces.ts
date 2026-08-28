export type PathSurfaceFamily = "path" | "external_directory";
export type PathSurfaceEffect = "read" | "write";

export type PathSurfaceInfo = {
  family: PathSurfaceFamily;
  effect?: PathSurfaceEffect;
};

const PATH_SURFACES: Readonly<Record<string, PathSurfaceInfo>> = Object.freeze({
  path: Object.freeze({ family: "path" }),
  path_read: Object.freeze({ family: "path", effect: "read" }),
  path_write: Object.freeze({ family: "path", effect: "write" }),
  external_directory: Object.freeze({ family: "external_directory" }),
  external_directory_read: Object.freeze({
    family: "external_directory",
    effect: "read",
  }),
  external_directory_write: Object.freeze({
    family: "external_directory",
    effect: "write",
  }),
});

/** Return metadata only for permission-system's six explicit path surfaces. */
export function pathSurfaceInfo(surface: unknown): PathSurfaceInfo | undefined {
  return typeof surface === "string" ? PATH_SURFACES[surface] : undefined;
}

export function isPathSurface(surface: unknown): boolean {
  return pathSurfaceInfo(surface) !== undefined;
}
