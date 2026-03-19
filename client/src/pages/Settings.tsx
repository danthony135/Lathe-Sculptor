import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useMachineConfig, useUpdateSetting } from "@/hooks/use-settings";
import type { MachineConfig, SpindleConfig } from "@shared/schema";
import { Settings as SettingsIcon, Cpu, Wrench, Zap, Save } from "lucide-react";

export default function Settings() {
  const { machineConfig, isLoading } = useMachineConfig();
  const updateSetting = useUpdateSetting();
  const { toast } = useToast();
  const [config, setConfig] = useState<MachineConfig | null>(null);

  useEffect(() => {
    if (machineConfig) {
      setConfig(structuredClone(machineConfig));
    }
  }, [machineConfig]);

  const handleSave = async () => {
    if (!config) return;
    try {
      await updateSetting.mutateAsync({ key: "machine_config", value: config });
      toast({ title: "Settings saved", description: "Machine configuration updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save settings.", variant: "destructive" });
    }
  };

  if (isLoading || !config) {
    return (
      <div className="container mx-auto p-8 text-center text-muted-foreground">
        Loading settings...
      </div>
    );
  }

  const updateField = <K extends keyof MachineConfig>(key: K, value: MachineConfig[K]) => {
    setConfig(prev => prev ? { ...prev, [key]: value } : prev);
  };

  const updateSpindle = (idx: number, field: keyof SpindleConfig, value: any) => {
    setConfig(prev => {
      if (!prev) return prev;
      const spindles = [...prev.spindles];
      spindles[idx] = { ...spindles[idx], [field]: value };
      return { ...prev, spindles };
    });
  };

  const updateSpindleMCode = (idx: number, field: keyof SpindleConfig['mCodes'], value: string) => {
    setConfig(prev => {
      if (!prev) return prev;
      const spindles = [...prev.spindles];
      spindles[idx] = { ...spindles[idx], mCodes: { ...spindles[idx].mCodes, [field]: value } };
      return { ...prev, spindles };
    });
  };

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold font-mono tracking-tight">SETTINGS</h1>
          <p className="text-muted-foreground mt-1">Configure machine parameters, spindles, and post-processor.</p>
        </div>
        <Button onClick={handleSave} disabled={updateSetting.isPending} className="gap-2">
          <Save className="h-4 w-4" />
          {updateSetting.isPending ? "Saving..." : "Save All"}
        </Button>
      </div>

      <Tabs defaultValue="machine" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="machine" className="gap-1"><SettingsIcon className="h-3 w-3" /> Machine</TabsTrigger>
          <TabsTrigger value="spindles" className="gap-1"><Cpu className="h-3 w-3" /> Spindles</TabsTrigger>
          <TabsTrigger value="mcodes" className="gap-1"><Wrench className="h-3 w-3" /> M-Codes</TabsTrigger>
          <TabsTrigger value="postprocessor" className="gap-1"><Zap className="h-3 w-3" /> Post-Processor</TabsTrigger>
        </TabsList>

        {/* Machine Tab */}
        <TabsContent value="machine">
          <Card>
            <CardHeader><CardTitle>Machine Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Machine Name</Label>
                  <Input value={config.name} onChange={e => updateField('name', e.target.value)} className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label>Model</Label>
                  <Input value={config.model} onChange={e => updateField('model', e.target.value)} className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label>Max Diameter (mm)</Label>
                  <Input type="number" value={config.maxDiameter} onChange={e => updateField('maxDiameter', Number(e.target.value))} className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label>Max Length (mm)</Label>
                  <Input type="number" value={config.maxLength} onChange={e => updateField('maxLength', Number(e.target.value))} className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label>Axes</Label>
                  <Select value={String(config.axes)} onValueChange={v => updateField('axes', Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="4">4-Axis</SelectItem>
                      <SelectItem value="5">5-Axis</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 flex items-end gap-3">
                  <div className="flex-1">
                    <Label>B-Axis Available</Label>
                    <div className="flex items-center gap-2 mt-2">
                      <Switch checked={config.hasB_axis} onCheckedChange={v => updateField('hasB_axis', v)} />
                      <span className="text-sm text-muted-foreground">{config.hasB_axis ? 'Yes' : 'No'}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold mb-3">Default Safe Positions</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Safe X (mm)</Label>
                    <Input type="number" value={config.safeX} onChange={e => updateField('safeX', Number(e.target.value))} className="font-mono" />
                  </div>
                  <div className="space-y-2">
                    <Label>Safe Y (mm)</Label>
                    <Input type="number" value={config.safeY} onChange={e => updateField('safeY', Number(e.target.value))} className="font-mono" />
                  </div>
                  <div className="space-y-2">
                    <Label>Safe Z (mm)</Label>
                    <Input type="number" value={config.safeZ} onChange={e => updateField('safeZ', Number(e.target.value))} className="font-mono" />
                  </div>
                </div>
              </div>

              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold mb-3">Default Feeds & Speeds</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Rapid Feed (mm/min)</Label>
                    <Input type="number" value={config.defaultRapidFeed} onChange={e => updateField('defaultRapidFeed', Number(e.target.value))} className="font-mono" />
                  </div>
                  <div className="space-y-2">
                    <Label>Work Feed (mm/min)</Label>
                    <Input type="number" value={config.defaultWorkFeed} onChange={e => updateField('defaultWorkFeed', Number(e.target.value))} className="font-mono" />
                  </div>
                  <div className="space-y-2">
                    <Label>Default RPM</Label>
                    <Input type="number" value={config.defaultSpindleRPM} onChange={e => updateField('defaultSpindleRPM', Number(e.target.value))} className="font-mono" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Spindles Tab */}
        <TabsContent value="spindles">
          <Card>
            <CardHeader><CardTitle>Spindle Configuration ({config.spindles.length} spindles)</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {config.spindles.map((spindle, idx) => (
                <div key={spindle.id} className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Cpu className="h-4 w-4 text-primary" />
                    <span className="font-semibold">{spindle.name}</span>
                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{spindle.type}</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input value={spindle.name} onChange={e => updateSpindle(idx, 'name', e.target.value)} className="font-mono text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Max RPM</Label>
                      <Input type="number" value={spindle.maxRPM} onChange={e => updateSpindle(idx, 'maxRPM', Number(e.target.value))} className="font-mono text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Power (kW)</Label>
                      <Input type="number" step="0.1" value={spindle.power} onChange={e => updateSpindle(idx, 'power', Number(e.target.value))} className="font-mono text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Start M-Code</Label>
                      <Input value={spindle.mCodes.start} onChange={e => updateSpindleMCode(idx, 'start', e.target.value)} className="font-mono text-sm" />
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* M-Codes Tab */}
        <TabsContent value="mcodes">
          <Card>
            <CardHeader><CardTitle>Loader & Auxiliary M-Codes</CardTitle></CardHeader>
            <CardContent className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold mb-3">Auto-Loader Sequence</h3>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {(Object.keys(config.loaderCodes) as (keyof typeof config.loaderCodes)[]).map(key => (
                    <div key={key} className="space-y-1">
                      <Label className="text-xs capitalize">{key}</Label>
                      <Input value={config.loaderCodes[key]} onChange={e => setConfig(prev => prev ? { ...prev, loaderCodes: { ...prev.loaderCodes, [key]: e.target.value } } : prev)} className="font-mono text-sm" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold mb-3">Auxiliary Controls</h3>
                <div className="grid grid-cols-2 gap-3 max-w-xs">
                  <div className="space-y-1">
                    <Label className="text-xs">Dust Collection ON</Label>
                    <Input value={config.auxCodes.dustOn} onChange={e => setConfig(prev => prev ? { ...prev, auxCodes: { ...prev.auxCodes, dustOn: e.target.value } } : prev)} className="font-mono text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Dust Collection OFF</Label>
                    <Input value={config.auxCodes.dustOff} onChange={e => setConfig(prev => prev ? { ...prev, auxCodes: { ...prev.auxCodes, dustOff: e.target.value } } : prev)} className="font-mono text-sm" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Post-Processor Tab */}
        <TabsContent value="postprocessor">
          <Card>
            <CardHeader><CardTitle>G-Code Post-Processor Settings</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Program End Code</Label>
                  <Input value={config.postProcessor.programEnd} onChange={e => setConfig(prev => prev ? { ...prev, postProcessor: { ...prev.postProcessor, programEnd: e.target.value } } : prev)} className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label>Coordinate System</Label>
                  <Input value={config.postProcessor.coordinateSystem} onChange={e => setConfig(prev => prev ? { ...prev, postProcessor: { ...prev.postProcessor, coordinateSystem: e.target.value } } : prev)} className="font-mono" />
                </div>
                <div className="space-y-2">
                  <Label>Units</Label>
                  <Select value={config.postProcessor.units} onValueChange={v => setConfig(prev => prev ? { ...prev, postProcessor: { ...prev.postProcessor, units: v as 'metric' | 'imperial' } } : prev)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="metric">Metric (mm)</SelectItem>
                      <SelectItem value="imperial">Imperial (in)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>X-Axis Mode</Label>
                  <Select value={config.postProcessor.xAxisMode} onValueChange={v => setConfig(prev => prev ? { ...prev, postProcessor: { ...prev.postProcessor, xAxisMode: v as 'diameter' | 'radius' } } : prev)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="diameter">Diameter</SelectItem>
                      <SelectItem value="radius">Radius</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
