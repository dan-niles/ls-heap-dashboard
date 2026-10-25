// Live heap dashboard for the Ballerina language servers running on this machine.
// Usage: node server.mjs [port]   then open http://localhost:<port>
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const PORT = Number(process.argv[2] || 7788);
const HERE = dirname(fileURLToPath(import.meta.url));

async function sh(cmd, args) {
    try {
        return (await run(cmd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
    } catch (e) {
        return e.stdout || "";
    }
}

async function findJcmd() {
    if (process.env.JCMD) {
        return process.env.JCMD;
    }
    const home = (await sh("/usr/libexec/java_home", [])).trim();
    return home ? join(home, "bin", "jcmd") : "jcmd";
}
const JCMD = await findJcmd();

// Names the app that owns a language server by walking up its parent processes.
async function appOf(pid) {
    let current = pid;
    for (let i = 0; i < 8 && current > 1; i++) {
        const [ppid, ...cmd] = (await sh("ps", ["-o", "ppid=,command=", "-p", String(current)])).trim().split(/\s+/);
        const command = cmd.join(" ");
        if (command.includes("WSO2 Agent Builder.app")) return "WSO2 Agent Builder";
        if (command.includes("WSO2 Integrator.app")) return "WSO2 Integrator";
        if (command.includes("Visual Studio Code") || command.includes("Code Helper")) return "VS Code";
        current = Number(ppid);
    }
    return "Unknown";
}

async function discover() {
    const out = await sh("pgrep", ["-f", "org.ballerinalang.langserver.launchers.stdio.Main"]);
    const pids = out.split("\n").map(Number).filter(Boolean);
    const procs = await Promise.all(pids.map(async (pid) =>
        ({ pid, command: (await sh("ps", ["-o", "command=", "-p", String(pid)])).trim() })));
    // Shells and scripts whose command line merely mentions the main class are not servers.
    const servers = procs.filter((p) => /(^|\/)java\s/.test(p.command));
    return Promise.all(servers.map(async ({ pid, command }) => {
        const jar = (command.match(/[^ :]*ballerina-language-server[^ :]*\.jar/) || [""])[0];
        let app = await appOf(pid);
        if (app === "VS Code" && /\/packages\/ballerina-extension\/ls\//.test(jar)) {
            app = "Dev host (" + jar.split("/packages/")[0].split("/").pop() + ")";
        }
        return { pid, app, jar };
    }));
}

async function heap(pid) {
    const [info, ps] = await Promise.all([
        sh(JCMD, [String(pid), "GC.heap_info"]),
        sh("ps", ["-o", "rss=,%cpu=,etime=", "-p", String(pid)]),
    ]);
    const kb = (re) => Number((info.match(re) || [0, 0])[1]);
    const [rss, cpu, etime] = ps.trim().split(/\s+/);
    return {
        usedMB: Math.round(kb(/used (\d+)K/) / 1024),
        committedMB: Math.round(kb(/committed (\d+)K/) / 1024),
        reservedMB: Math.round(kb(/total reserved (\d+)K/) / 1024),
        metaspaceMB: Math.round(kb(/Metaspace\s+used (\d+)K/) / 1024),
        rssMB: Math.round(Number(rss || 0) / 1024),
        cpu: Number(cpu || 0),
        uptime: etime || "",
    };
}

// Classes that show what a language server holds; counts come from a live-object histogram.
const TRACKED = {
    "io.ballerina.projects.directory.WorkspaceProject": "Workspace projects (real + expression copies)",
    "io.ballerina.projects.directory.BuildProject": "Package projects",
    "io.ballerina.projects.bala.BalaProject": "Library (bala) projects",
    "io.ballerina.projects.directory.SingleFileProject": "Single-file projects",
    "io.ballerina.compiler.syntax.tree.SyntaxTree": "Syntax trees (parsed files)",
    "io.ballerina.projects.PackageCompilation": "Package compilations",
    "org.wso2.ballerinalang.compiler.util.CompilerContext": "Compiler environments",
    "org.wso2.ballerinalang.compiler.tree.BLangPackage": "Compiled module trees",
};

async function breakdown(pid) {
    const out = await sh(JCMD, [String(pid), "GC.class_histogram"]);
    const rows = [];
    for (const line of out.split("\n")) {
        const m = line.match(/^\s*\d+:\s+(\d+)\s+(\d+)\s+(\S+)/);
        if (m) rows.push({ cls: m[3], count: Number(m[1]), bytes: Number(m[2]) });
    }
    const total = rows.reduce((s, r) => s + r.bytes, 0);
    const tracked = Object.entries(TRACKED).map(([cls, label]) => {
        const r = rows.find((x) => x.cls === cls);
        return { label, cls, count: r ? r.count : 0 };
    });
    const top = rows.slice(0, 12).map((r) => ({ cls: r.cls, count: r.count, mb: +(r.bytes / 1048576).toFixed(1) }));
    return { liveMB: Math.round(total / 1048576), tracked, top, at: Date.now() };
}

async function gc(pid) {
    await sh(JCMD, [String(pid), "GC.run"]);
    await sh(JCMD, [String(pid), "GC.run"]);
    return heap(pid);
}

function send(res, code, body, type = "application/json") {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
}

createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pid = Number(url.searchParams.get("pid"));
    try {
        if (url.pathname === "/") return send(res, 200, readFileSync(join(HERE, "index.html")), "text/html");
        if (url.pathname === "/api/instances") {
            const list = await discover();
            const withHeap = await Promise.all(list.map(async (i) => ({ ...i, ...(await heap(i.pid)), at: Date.now() })));
            return send(res, 200, withHeap);
        }
        if (url.pathname === "/api/gc" && pid) return send(res, 200, { ...(await gc(pid)), at: Date.now() });
        if (url.pathname === "/api/breakdown" && pid) return send(res, 200, await breakdown(pid));
        send(res, 404, { error: "not found" });
    } catch (e) {
        send(res, 500, { error: String(e) });
    }
}).listen(PORT, "127.0.0.1", () => console.log(`Heap dashboard on http://localhost:${PORT} (jcmd: ${JCMD})`));
