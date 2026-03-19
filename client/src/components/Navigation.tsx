import { Link, useLocation } from "wouter";
import { LayoutDashboard, Wrench, Settings, Box, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";

export function Navigation() {
  const [location] = useLocation();

  const links = [
    { href: "/", label: "Projects", icon: Box },
    { href: "/tools", label: "Tool Library", icon: Wrench },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <nav className="w-16 md:w-64 border-r border-border bg-card flex flex-col h-screen fixed left-0 top-0 z-50 transition-all duration-300">
      <div className="p-4 md:p-6 border-b border-border flex items-center justify-center md:justify-start gap-3">
        <div className="w-8 h-8 rounded bg-primary flex items-center justify-center shrink-0 shadow-[0_0_15px_rgba(var(--primary),0.5)]">
          <span className="font-mono font-bold text-primary-foreground text-lg">C</span>
        </div>
        <span className="font-bold text-lg hidden md:block font-mono tracking-tight">
          CATEK<span className="text-primary">CAM</span>
        </span>
      </div>

      <div className="flex-1 py-6 px-2 md:px-4 space-y-2">
        {links.map((link) => {
          const isActive = location === link.href;
          const Icon = link.icon;
          
          return (
            <Link key={link.href} href={link.href}>
              <div
                className={cn(
                  "flex items-center gap-3 px-3 py-3 rounded-md transition-all duration-200 cursor-pointer group",
                  isActive
                    ? "bg-primary/10 text-primary border border-primary/20 shadow-[0_0_10px_rgba(14,165,233,0.1)]"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                )}
              >
                <Icon className={cn("w-5 h-5", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                <span className="hidden md:block font-medium">{link.label}</span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-3 px-3 py-3 text-muted-foreground hover:text-foreground cursor-pointer rounded-md hover:bg-white/5 transition-colors">
          <LogOut className="w-5 h-5" />
          <span className="hidden md:block font-medium">Disconnect</span>
        </div>
      </div>
    </nav>
  );
}
