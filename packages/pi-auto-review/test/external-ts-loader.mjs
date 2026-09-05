// Node refuses to type-strip TypeScript under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and @gotgenes/pi-permission-system
// ships its runtime as .ts sources that also use extensionless relative
// imports. This hook scopes both jobs to node_modules only:
//   - resolve: retry extensionless relative specifiers with ".ts"
//   - load: transpile .ts sources via the typescript devDependency
// Everything else (our own src/ and test/) runs through Node's native
// TypeScript transform, so local code pays no transpilation cost.
import { readFile } from "node:fs/promises";
import ts from "typescript";

const isExternal = (url) => url.includes("/node_modules/");
const isExternalTypeScript = (url) => isExternal(url) && url.endsWith(".ts");

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code !== "ERR_MODULE_NOT_FOUND" ||
      (!specifier.startsWith(".") &&
        !specifier.startsWith("file:") &&
        !specifier.startsWith("#"))
    ) {
      throw error;
    }
    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (!isExternalTypeScript(url)) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
      fileName: new URL(url).pathname,
    }).outputText,
  };
}
