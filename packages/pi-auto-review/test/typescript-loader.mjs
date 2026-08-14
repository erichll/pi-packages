import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code !== "ERR_MODULE_NOT_FOUND" ||
      (!specifier.startsWith(".") && !specifier.startsWith("file:"))
    ) {
      throw error;
    }
    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
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