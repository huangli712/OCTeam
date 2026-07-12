import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

const ROOT = path.resolve("src/orchestration")
const ALLOWED_DEPENDENCIES: Readonly<Record<string, ReadonlySet<string>>> = {
    protocol: new Set(),
    records: new Set(["protocol"]),
    control: new Set(["protocol", "records"]),
    modes: new Set(["protocol", "records", "control"]),
    workflow: new Set(["protocol", "records", "control"]),
    lifecycle: new Set(["protocol", "records", "control", "modes", "workflow"]),
}

async function orchestrationFiles(): Promise<string[]> {
    const files: string[] = []
    for (const directory of Object.keys(ALLOWED_DEPENDENCIES)) {
        const entries = await readdir(path.join(ROOT, directory), { withFileTypes: true })
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(".ts")) {
                files.push(path.join(ROOT, directory, entry.name))
            }
        }
    }
    return files
}

function importedModules(source: string, filePath: string): string[] {
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
    const modules: string[] = []
    sourceFile.forEachChild(node => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier !== undefined
            && ts.isStringLiteral(node.moduleSpecifier)
        ) {
            modules.push(node.moduleSpecifier.text)
        }
    })
    return modules
}

function internalTarget(filePath: string, moduleSpecifier: string): string | undefined {
    if (!moduleSpecifier.startsWith(".")) return undefined
    const target = path.resolve(path.dirname(filePath), moduleSpecifier).replace(/\.js$/, ".ts")
    return target.startsWith(`${ROOT}${path.sep}`) ? target : undefined
}

async function importGraph(): Promise<ReadonlyMap<string, readonly string[]>> {
    const graph = new Map<string, readonly string[]>()
    for (const filePath of await orchestrationFiles()) {
        const source = await readFile(filePath, "utf8")
        const targets = importedModules(source, filePath)
            .map(moduleSpecifier => internalTarget(filePath, moduleSpecifier))
            .filter((target): target is string => target !== undefined)
        graph.set(filePath, targets)
    }
    return graph
}

function findImportCycle(graph: ReadonlyMap<string, readonly string[]>): readonly string[] | undefined {
    const visited = new Set<string>()
    const active = new Set<string>()
    const stack: string[] = []

    const visit = (filePath: string): readonly string[] | undefined => {
        if (active.has(filePath)) {
            const start = stack.indexOf(filePath)
            return [...stack.slice(start), filePath]
        }
        if (visited.has(filePath)) return undefined

        active.add(filePath)
        stack.push(filePath)
        for (const target of graph.get(filePath) ?? []) {
            const cycle = visit(target)
            if (cycle !== undefined) return cycle
        }
        stack.pop()
        active.delete(filePath)
        visited.add(filePath)
        return undefined
    }

    for (const filePath of graph.keys()) {
        const cycle = visit(filePath)
        if (cycle !== undefined) return cycle
    }
    return undefined
}

describe("orchestration directory layering", () => {
    test("root contains exactly the six approved subdirectories and no TypeScript files", async () => {
        const entries = await readdir(ROOT, { withFileTypes: true })
        const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
        const typeScriptFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith(".ts"))

        expect(directories).toEqual(Object.keys(ALLOWED_DEPENDENCIES).sort())
        expect(typeScriptFiles).toEqual([])
    })

    test("imports follow the approved directory dependency edges", async () => {
        const violations: string[] = []
        for (const [source, targets] of await importGraph()) {
            const sourceLayer = path.relative(ROOT, source).split(path.sep)[0]
            for (const target of targets) {
                const targetLayer = path.relative(ROOT, target).split(path.sep)[0]
                if (sourceLayer === targetLayer) continue
                if (!ALLOWED_DEPENDENCIES[sourceLayer]?.has(targetLayer)) {
                    violations.push(`${path.relative(ROOT, source)} -> ${path.relative(ROOT, target)}`)
                }
            }
        }
        expect(violations).toEqual([])
    })

    test("internal import graph has no cycles", async () => {
        const cycle = findImportCycle(await importGraph())
        expect(cycle?.map(filePath => path.relative(ROOT, filePath))).toBeUndefined()
    })
})
