import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Navigation } from "@/components/Navigation";
import NotFound from "@/pages/not-found";

// Pages
import Dashboard from "@/pages/Dashboard";
import ProjectEditor from "@/pages/ProjectEditor";
import ToolLibrary from "@/pages/ToolLibrary";
import Settings from "@/pages/Settings";

function Router() {
  return (
    <Switch>
      {/* 
        Full Layout Pages (Dashboard, Tools, Settings) 
        These have the sidebar navigation 
      */}
      <Route path="/">
        <div className="flex min-h-screen bg-background text-foreground font-sans">
          <Navigation />
          <main className="flex-1 ml-16 md:ml-64 transition-all duration-300">
            <Dashboard />
          </main>
        </div>
      </Route>

      <Route path="/tools">
        <div className="flex min-h-screen bg-background text-foreground font-sans">
          <Navigation />
          <main className="flex-1 ml-16 md:ml-64 transition-all duration-300">
            <ToolLibrary />
          </main>
        </div>
      </Route>

      <Route path="/settings">
        <div className="flex min-h-screen bg-background text-foreground font-sans">
          <Navigation />
          <main className="flex-1 ml-16 md:ml-64 transition-all duration-300">
            <Settings />
          </main>
        </div>
      </Route>

      {/* 
        Editor takes over the full screen, no sidebar 
        It has its own internal layout
      */}
      <Route path="/project/:id" component={ProjectEditor} />

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
