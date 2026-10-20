import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

// electron-vite gives every main-process bundle its own `__dirname` and
// `__filename`, so a module that declares either makes the bundle a syntax
// error at load: the app fails to start while its tests, which never load the
// bundle, still pass. Modules use `import.meta.dirname` instead. The main
// process bundles the app's main and shared code and, in its SDK host, the SDK.
const SHIMMED = new Set(["__dirname", "__filename"]);
const ROOTS = ["src/gui/main", "src/gui/shared", "sdk/src"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** The shimmed names a module declares at its top level. */
function declaredShims(code: string): string[] {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const found: string[] = [];
  for (const statement of ast.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier" && SHIMMED.has(declarator.id.name)) found.push(declarator.id.name);
      }
    }
    if (declaration?.type === "FunctionDeclaration" && declaration.id && SHIMMED.has(declaration.id.name)) found.push(declaration.id.name);
  }
  return found;
}

describe("main-process modules and electron-vite's shims", () => {
  it("declare no __dirname or __filename of their own", () => {
    const offenders = ROOTS.flatMap((root) => sourceFiles(root)).flatMap((file) =>
      declaredShims(readFileSync(file, "utf8")).map((name) => `${file}: ${name}`));
    expect(offenders).toEqual([]);
  });

  it("finds such a declaration", () => {
    const planted = 'import { fileURLToPath } from "node:url";\nconst __filename = fileURLToPath(import.meta.url);\nexport function __dirname() {}\n';
    expect(declaredShims(planted)).toEqual(["__filename", "__dirname"]);
  });
});
