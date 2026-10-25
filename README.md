# LS heap dashboard

Live heap of every Ballerina language server running on this machine (dev host, WSO2 Agent Builder,
WSO2 Integrator), labelled by the app that started it.

```bash
node server.mjs      # then open http://localhost:7788
```

Needs a JDK with `jcmd` (found through `/usr/libexec/java_home`, or set `JCMD=/path/to/jcmd`).
No npm install; the page loads Chart.js from cdnjs.

## What it shows

| Item | Meaning |
|---|---|
| Heap used | Current heap, including garbage not yet collected (updates every 2 s) |
| Live after GC | Heap right after a full GC: what the server really retains |
| Force GC / Auto GC | Runs a full GC (Auto: every 10 s) so retained memory is visible |
| Breakdown | Live-object counts: workspace projects (real + expression copies), package projects, syntax trees, compiler environments, plus the largest classes |
| Add Marker | Draws a labelled line on every chart (for example "form opened") |

A full GC pauses the server briefly (well under a second on a ~1 GB heap); avoid Auto GC while
measuring latency.

## Demo: expression copy retained after a form closes

1. Open a project in the app, open a diagram. Turn **Auto GC** on and note "Live after GC".
2. Add a marker "form opened", open a node form. Live heap rises by roughly one compiled copy of the
   project (~400 MB on a 40k-line workspace). **Breakdown** shows one more workspace project.
3. Add a marker "form closed", close the form. Live heap stays up: the copy is still retained.

Cause: the language server keeps a compiled expression copy of the project after a form closes, and static compiler state in `ballerina-lang` keeps the last compiled workspace reachable.
