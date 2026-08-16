import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useMachineConfig } from "@/hooks/use-settings";
import { CATEK_TOOL_CYLINDER_CODES } from "@shared/schema";
import {
  GraduationCap, Compass, Wrench, ListOrdered, Code2, ShieldAlert,
} from "lucide-react";

// Descriptions for the default Catek tool positions (matches seeded tool library)
const TOOL_DESCRIPTIONS: Record<number, string> = {
  1: "Turning Knife #1 — primary profile cuts",
  2: "Turning Knife #2 — detail work",
  3: "Sanding Tool — rotary sanding attachment",
  4: "Drill Tool — center drilling and boring",
  5: "Router / Engraving Tool",
  6: "Planer Blade — surface planing",
  7: "Parting / Grooving Tool",
  8: "V-Bit 60° — V-carving and engraving",
  9: "Ball Nose 6mm — 3D carving",
  10: "Threading Tool",
  11: "Auxiliary cylinder 11",
  12: "Auxiliary cylinder 12",
};

const GCODE_REFERENCE: { code: string; meaning: string; notes: string }[] = [
  { code: "G0", meaning: "Rapid move", notes: "Full speed positioning — never cut with G0" },
  { code: "G1", meaning: "Linear feed move", notes: "Cutting move at F feed rate (mm/min)" },
  { code: "G02 / G03", meaning: "Arc CW / CCW", notes: "With I/J/K center offsets" },
  { code: "G40 / G41 / G42", meaning: "Tool compensation off / left / right", notes: "Uses D offset number" },
  { code: "G76", meaning: "Threading cycle", notes: "Two-line Fanuc compound thread cycle" },
  { code: "G80", meaning: "Cancel canned cycle", notes: "Ends G81/G83 drilling modes" },
  { code: "G81 / G83", meaning: "Drill / peck-drill cycle", notes: "G83 retracts between pecks (Q = peck depth)" },
  { code: "G93 / G94", meaning: "Inverse-time / feed-per-minute", notes: "G93 used for simultaneous A-axis moves" },
  { code: "Ttttt", meaning: "Tool select + offset", notes: "e.g. T0404 = tool 4 with offset 4" },
  { code: "M03 / M04 / M05", meaning: "Spindle forward / reverse / stop", notes: "With S word for RPM" },
  { code: "M30", meaning: "Program end", notes: "Rewinds program" },
];

export default function Training() {
  const { machineConfig } = useMachineConfig();
  const cylinderCodes = machineConfig?.toolCylinderCodes ?? CATEK_TOOL_CYLINDER_CODES;

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight flex items-center gap-3">
          <GraduationCap className="h-8 w-8 text-primary" />
          MACHINE TRAINING
        </h1>
        <p className="text-muted-foreground mt-1">
          Reference guide for operating the Catek 7-in-1 CNC wood lathe.
        </p>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-3 md:grid-cols-6">
          <TabsTrigger value="overview" className="gap-1"><GraduationCap className="h-3 w-3" /> Overview</TabsTrigger>
          <TabsTrigger value="coordinates" className="gap-1"><Compass className="h-3 w-3" /> Axes</TabsTrigger>
          <TabsTrigger value="tools" className="gap-1"><Wrench className="h-3 w-3" /> Tools & M-Codes</TabsTrigger>
          <TabsTrigger value="workflow" className="gap-1"><ListOrdered className="h-3 w-3" /> Workflow</TabsTrigger>
          <TabsTrigger value="gcode" className="gap-1"><Code2 className="h-3 w-3" /> G-Code</TabsTrigger>
          <TabsTrigger value="safety" className="gap-1"><ShieldAlert className="h-3 w-3" /> Safety</TabsTrigger>
        </TabsList>

        {/* ================= OVERVIEW ================= */}
        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>The Catek 7-in-1</CardTitle>
              <CardDescription>One machine, seven ways to shape wood.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-relaxed">
                The Catek 7-in-1 is a 4-axis CNC wood lathe with a multi-position turret.
                The workpiece spins on the main spindle (the A-axis) between the headstock and
                tailstock, while tools move along the length of the piece (Z), in and out
                (X, programmed as diameter), and vertically (Y). Each tool on the turret is
                pushed into working position by a pneumatic cylinder controlled with M-codes.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  ["Turning", "Continuous spinning workpiece, knife follows the profile — spindles, table legs, balusters."],
                  ["Milling / Routing", "Workpiece held at an indexed angle (or rotated simultaneously) while a router spindle cuts — flats, flutes, mortises."],
                  ["Drilling", "G81/G83 canned cycles, straight or peck drilling, single holes or indexed patterns around the piece."],
                  ["Grooving", "Plunge cuts for square, V, or round grooves at set Z positions."],
                  ["Planing", "High-speed planer spindle flattens a face with the A-axis locked."],
                  ["Engraving", "Text or vector artwork traced on the surface with a V-bit or engraving cutter."],
                  ["3D Carving", "Simultaneous 4-axis surface machining from an STL/OBJ model with a ball-nose cutter."],
                ].map(([name, desc]) => (
                  <div key={name} className="border rounded-lg p-3">
                    <div className="font-semibold text-sm">{name}</div>
                    <div className="text-xs text-muted-foreground mt-1">{desc}</div>
                  </div>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                Plus sanding (profile-following paddle) and threading (G76 cycle) support.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Spindles</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Spindle</TableHead>
                    <TableHead>Max RPM</TableHead>
                    <TableHead>Power</TableHead>
                    <TableHead>Start / Stop</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(machineConfig?.spindles ?? []).map(s => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="font-mono">{s.maxRPM}</TableCell>
                      <TableCell className="font-mono">{s.power} kW</TableCell>
                      <TableCell className="font-mono">{s.mCodes.start} / {s.mCodes.stop}</TableCell>
                    </TableRow>
                  ))}
                  {!machineConfig && (
                    <TableRow><TableCell colSpan={4} className="text-muted-foreground">Loading machine configuration…</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================= COORDINATES ================= */}
        <TabsContent value="coordinates" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Coordinate System</CardTitle>
              <CardDescription>How the machine thinks about position — get this wrong and the tool goes the wrong way.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="border rounded-lg p-4">
                  <div className="font-mono font-bold text-primary text-lg">X — Diameter</div>
                  <p className="text-sm mt-2 leading-relaxed">
                    X is programmed as <strong>diameter, not radius</strong>. <span className="font-mono">X50</span> means
                    the part will be 50&nbsp;mm across — the tool tip is actually 25&nbsp;mm from center.
                    Bigger X = tool farther from center (safer). Smaller X = deeper cut.
                  </p>
                </div>
                <div className="border rounded-lg p-4">
                  <div className="font-mono font-bold text-primary text-lg">Z — Along the Bed</div>
                  <p className="text-sm mt-2 leading-relaxed">
                    <span className="font-mono">Z0</span> is at the <strong>spindle face</strong> (headstock end).
                    Movement toward the tailstock is <strong>negative</strong>. A 300&nbsp;mm part
                    runs from Z0 to Z-300.
                  </p>
                </div>
                <div className="border rounded-lg p-4">
                  <div className="font-mono font-bold text-primary text-lg">Y — Vertical</div>
                  <p className="text-sm mt-2 leading-relaxed">
                    Used in milling, planing, and engraving. Negative Y feeds the cutter down into
                    the work; the safe park position is up at positive Y
                    (default safe Y: <span className="font-mono">{machineConfig?.safeY ?? 75}</span>).
                  </p>
                </div>
                <div className="border rounded-lg p-4">
                  <div className="font-mono font-bold text-primary text-lg">A — Workpiece Rotation</div>
                  <p className="text-sm mt-2 leading-relaxed">
                    The main spindle doubles as a rotary axis. <strong>Continuous</strong> mode spins the piece
                    for turning; <strong>indexed</strong> mode locks it at angles (e.g. <span className="font-mono">A0, A90, A180, A270</span>)
                    for milling flats; <strong>simultaneous</strong> mode rotates while cutting for spirals and 3D carving.
                  </p>
                </div>
              </div>
              <div className="border rounded-lg p-4 bg-muted/40">
                <div className="font-semibold text-sm mb-2">Safe positions (from Settings)</div>
                <p className="text-sm font-mono">
                  Safe X: {machineConfig?.safeX ?? 100} &nbsp;|&nbsp; Safe Y: {machineConfig?.safeY ?? 75} &nbsp;|&nbsp; Safe Z: {machineConfig?.safeZ ?? 50}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Generated programs retract to these between operations. Verify they clear your workpiece diameter before running.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================= TOOLS & M-CODES ================= */}
        <TabsContent value="tools" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Tool Cylinder M-Codes</CardTitle>
              <CardDescription>
                Every turret tool is driven by a pneumatic cylinder. The <strong>even</strong> M-code engages
                the tool; the <strong>next odd number</strong> disengages it. The G-code generator inserts these
                automatically after each tool select and at the end of each operation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tool / Cylinder</TableHead>
                    <TableHead>Engage</TableHead>
                    <TableHead>Disengage</TableHead>
                    <TableHead className="hidden md:table-cell">Default Tool</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(cylinderCodes)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([toolNum, codes]) => (
                      <TableRow key={toolNum}>
                        <TableCell className="font-medium">Tool {toolNum}</TableCell>
                        <TableCell><Badge variant="outline" className="font-mono">{codes.engage}</Badge></TableCell>
                        <TableCell><Badge variant="secondary" className="font-mono">{codes.disengage}</Badge></TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                          {TOOL_DESCRIPTIONS[Number(toolNum)] ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground mt-3">
                Example: to cut with tool 1, the program issues <span className="font-mono">T0101</span> then{" "}
                <span className="font-mono">{cylinderCodes[1]?.engage ?? "M70"}</span> to engage, and{" "}
                <span className="font-mono">{cylinderCodes[1]?.disengage ?? "M71"}</span> when the pass is done.
                Edit these codes in Settings → M-Codes if your machine differs.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tool Numbering</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed">
              <p>
                Tools are selected with the Fanuc <span className="font-mono">Ttttt</span> format: the first two
                digits pick the tool, the last two pick its offset register. In practice both are the same, so
                tool 4 is <span className="font-mono">T0404</span>.
              </p>
              <p>
                Tool geometry and wear offsets live in the Tool Library and are applied during G-code generation.
                After changing or re-seating a physical tool, re-touch its offsets before cutting.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================= WORKFLOW ================= */}
        <TabsContent value="workflow" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>From CAD File to Finished Part</CardTitle>
              <CardDescription>The standard job workflow, start to finish.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="space-y-4">
                {[
                  ["Create a project", "From the Projects page, create a new project. Everything about the job — geometry, stock, operations, G-code — is saved in it."],
                  ["Import your CAD file", "DXF for 2D profiles, STL/OBJ for 3D models. A profile drawn in DXF should represent the part's outline; 3DSOLID DXF files are converted to a mesh automatically (FreeCAD-assisted). Check that detected units match reality — a 10× size error is usually inches vs millimeters."],
                  ["Define the stock", "Set the raw blank's diameter and length, and material. The stock must be larger than the finished part everywhere."],
                  ["Check the tool library", "Confirm the tools you'll use exist with correct diameters, feeds, and offsets."],
                  ["Add operations in cutting order", "Typical order: roughing → turning/finishing → detail work (grooving, drilling, engraving) → sanding. Each operation gets a tool number, feed, speed, and depth of cut."],
                  ["Generate G-code", "The generator writes a Catek-style program: tool selects (Ttttt), cylinder engage/disengage M-codes, spindle starts, and the toolpath. Review it — especially the first program with new settings."],
                  ["Preview in 3D", "The viewer shows the toolpath over the stock. Look for moves that plunge through the part or rapid moves below the surface."],
                  ["Load the program on the machine", "Transfer the .nc file to the Catek controller."],
                  ["Dry run first", "Run the program above the work (or with stock removed) at reduced rapid override. Watch each tool engage and disengage at the right moments."],
                  ["Cut", "Load and clamp the blank, zero your offsets, and run. Stay at the controls for the first piece."],
                ].map(([title, desc], i) => (
                  <li key={i} className="flex gap-4">
                    <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 text-primary flex items-center justify-center font-mono font-bold shrink-0">
                      {i + 1}
                    </div>
                    <div>
                      <div className="font-semibold text-sm">{title}</div>
                      <div className="text-sm text-muted-foreground mt-0.5 leading-relaxed">{desc}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================= G-CODE ================= */}
        <TabsContent value="gcode" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>G-Code Quick Reference</CardTitle>
              <CardDescription>The codes you'll see in generated Catek programs.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Meaning</TableHead>
                    <TableHead className="hidden md:table-cell">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {GCODE_REFERENCE.map(row => (
                    <TableRow key={row.code}>
                      <TableCell className="font-mono font-semibold whitespace-nowrap">{row.code}</TableCell>
                      <TableCell className="text-sm">{row.meaning}</TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{row.notes}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Reading a Generated Program</CardTitle></CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="anatomy">
                  <AccordionTrigger className="text-sm">Anatomy of a program</AccordionTrigger>
                  <AccordionContent>
                    <pre className="bg-muted/50 rounded-lg p-4 text-xs font-mono overflow-x-auto leading-relaxed">{`MY PROJECT            ← program name
T0909                 ← initialization tool selects
T0202
T0707

(LOAD AND CLAMP PIECE)

(ROUGHING - TOOL 4)   ← operation header comment
T0404                 ← select tool 4
${cylinderCodes[4]?.engage ?? "M76"}                   ← engage tool 4 cylinder
G0Z0                  ← rapid to start
M03 S2100             ← spindle on, 2100 RPM
G0X62.000 Z0          ← rapid to cutting diameter
G1Z-300.0 F200        ← cut along the length, feed 200
G0X100                ← retract
${cylinderCodes[4]?.disengage ?? "M77"}                   ← disengage tool 4 cylinder

M05                   ← spindle stop
M30                   ← program end`}</pre>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="diameter">
                  <AccordionTrigger className="text-sm">Why X values look "doubled"</AccordionTrigger>
                  <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                    Because X is diameter mode, a profile point 25&nbsp;mm from center is written
                    as <span className="font-mono">X50.000</span>. When importing G-code, the app converts back
                    (X ÷ 2) for display. If a preview looks twice as fat or thin as expected, diameter/radius
                    mode is the first thing to check (Settings → Post-Processor).
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="feeds">
                  <AccordionTrigger className="text-sm">Feeds and speeds starting points (wood)</AccordionTrigger>
                  <AccordionContent className="text-sm leading-relaxed text-muted-foreground space-y-2">
                    <p>Roughing: 2100 RPM, 200 mm/min, 3 mm depth of cut. Finishing: same RPM, lighter cut.</p>
                    <p>Sanding: 2400 RPM, 1500 mm/min traverse.</p>
                    <p>Drilling: 1500 RPM, 100 mm/min, peck at 1–2× drill diameter.</p>
                    <p>Routing/carving: 12000–18000 RPM, 200–500 mm/min.</p>
                    <p>Hardwoods and large diameters need slower speeds; listen to the cut — chatter means slow down the feed or take a lighter pass.</p>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================= SAFETY ================= */}
        <TabsContent value="safety" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-destructive" />
                Before Every Run
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {[
                  "Verify the E-stop works before the first cut of the day.",
                  "Confirm stock is clamped tight and tailstock is engaged for long work.",
                  "Check that safe X/Y/Z positions clear the actual stock diameter — a fatter blank than the program expects means collisions.",
                  "Dry-run any new or edited program before cutting.",
                  "Verify each tool's cylinder engages and disengages at the right time during the dry run — a tool left engaged will crash on the next operation's moves.",
                  "Never reach into the machine envelope while the spindle is turning.",
                  "Wear eye protection; tie back loose clothing and hair.",
                  "Keep dust extraction running — fine wood dust is a fire and breathing hazard.",
                  "Sharp tools cut cooler and safer than dull ones; inspect edges regularly.",
                  "Stay at the controls for the entire first piece of any new program.",
                ].map((item, i) => (
                  <li key={i} className="flex gap-3 items-start">
                    <span className="text-primary font-mono font-bold shrink-0">{String(i + 1).padStart(2, "0")}</span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>If Something Goes Wrong</CardTitle></CardHeader>
            <CardContent className="text-sm leading-relaxed space-y-2">
              <p><strong>Chatter or squealing:</strong> feed too fast or cut too deep — reduce feed override, take lighter passes.</p>
              <p><strong>Burning smell:</strong> dull tool or RPM too high for the diameter — stop and inspect the edge.</p>
              <p><strong>Tool didn't retract:</strong> hit E-stop, then check the program for a missing disengage M-code before re-running.</p>
              <p><strong>Part slipping in the clamp:</strong> stop immediately; re-face the drive end and re-clamp. Never try to "catch" a spinning part.</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
