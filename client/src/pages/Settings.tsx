import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function Settings() {
  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8 max-w-4xl">
       <div>
          <h1 className="text-3xl font-bold font-mono tracking-tight">SETTINGS</h1>
          <p className="text-muted-foreground mt-1">Configure machine parameters and post-processor defaults.</p>
        </div>

        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle>Machine Configuration (Catek 7-in-1)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                   <Label>Max Spindle Speed (RPM)</Label>
                   <Input defaultValue="3000" className="font-mono" />
                </div>
                <div className="space-y-2">
                   <Label>Max Feed Rate (mm/min)</Label>
                   <Input defaultValue="2000" className="font-mono" />
                </div>
                <div className="space-y-2">
                   <Label>G-Code Header</Label>
                   <Input defaultValue="G21 G18 G90 G40" className="font-mono" />
                   <p className="text-xs text-muted-foreground">Defaults: Metric, XZ Plane, Absolute, Cancel Comp</p>
                </div>
                <div className="space-y-2">
                   <Label>Safety Z (Retract Height)</Label>
                   <Input defaultValue="5.0" className="font-mono" />
                </div>
             </div>
             
             <div className="pt-4 border-t border-border mt-6">
               <Button className="bg-primary hover:bg-primary/90">Save Configuration</Button>
             </div>
          </CardContent>
        </Card>
    </div>
  );
}
