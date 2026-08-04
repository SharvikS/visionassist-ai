"use client";

import { useState } from "react";
import {
  ChevronLeft,
  KeyRound,
  LayoutGrid,
  Lock,
  MessageSquareCode,
  MonitorPlay,
  MousePointerClick,
  ShieldCheck,
  Waves,
} from "lucide-react";
import ApiKeyModal from "./ApiKeyModal";
import AutomationPanel from "./AutomationPanel";
import ModelSwitcher from "./ModelSwitcher";
import ScreenCapturePanel from "./ScreenCapturePanel";
import TestConsole from "./TestConsole";
import UsageOverlay from "./UsageOverlay";
import VoicePanel from "./VoicePanel";
import Button from "./ui/Button";
import Panel from "./ui/Panel";
import SegmentedControl, { type Segment } from "./ui/SegmentedControl";
import { useVault } from "./vault-context";

type View = "all" | "vision" | "chat" | "voice" | "auto";

const SEGMENTS: Segment<View>[] = [
  { id: "all", label: "All", icon: LayoutGrid },
  { id: "vision", label: "Vision", icon: MonitorPlay },
  { id: "chat", label: "Chat", icon: MessageSquareCode },
  { id: "voice", label: "Voice", icon: Waves },
  { id: "auto", label: "Automate", icon: MousePointerClick },
];

export default function Dashboard() {
  const { lock, configured } = useVault();
  const [showKeys, setShowKeys] = useState(false);
  const [view, setView] = useState<View>("all");
  const [collapsed, setCollapsed] = useState(false);

  const grid = view === "all";
  /** Expanding a panel and picking its tab are the same action, so they share state. */
  const focusToggle = (id: View) => () => setView((v) => (v === id ? "all" : id));

  return (
    <div className="relative flex min-h-screen">
      <div className="va-aurora" aria-hidden />
      <div className="va-grid-overlay" aria-hidden />

      {/* ---------------------------------------------------------------- Sidebar */}
      <aside
        className={
          "va-glass relative z-10 flex shrink-0 flex-col border-r border-border transition-[width] duration-500 " +
          (collapsed ? "w-[72px]" : "w-72")
        }
        style={{ transitionTimingFunction: "var(--ease-out)" }}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-4">
          <div className="va-float relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-violet text-white shadow-lg shadow-accent/30">
            <ShieldCheck size={18} />
          </div>
          {!collapsed && (
            <div className="va-in-left min-w-0">
              <div className="va-gradient-text truncate text-sm font-semibold leading-tight">
                VisionAssist AI
              </div>
              <div className="truncate text-[11px] text-muted">BYOK · privacy-first</div>
            </div>
          )}
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto overflow-x-hidden p-4">
          {collapsed ? (
            <div className="flex flex-col items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowKeys(true)}
                aria-label="Manage API keys"
                title="Manage API keys"
              >
                <KeyRound size={15} className="text-accent" />
              </Button>
            </div>
          ) : (
            <>
              <div className="va-in-left">
                <ModelSwitcher />
              </div>

              <button
                onClick={() => setShowKeys(true)}
                className="va-btn va-focus va-in-left va-d-1 flex w-full items-center gap-2 rounded-xl border border-border bg-surface-2/60 px-3 py-2.5 text-sm transition hover:border-accent"
              >
                <KeyRound size={15} className="text-accent" />
                Manage API keys
                <span className="ml-auto rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
                  {configured.length} set
                </span>
              </button>

              <div className="va-in-left va-d-2">
                <UsageOverlay />
              </div>
            </>
          )}
        </div>

        <div className="space-y-2 border-t border-border p-3">
          <Button
            variant="ghost"
            size={collapsed ? "icon" : "md"}
            onClick={lock}
            className={collapsed ? "mx-auto" : "w-full justify-center"}
            aria-label="Lock vault"
            title="Lock vault"
          >
            <Lock size={15} />
            {!collapsed && "Lock vault"}
          </Button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="va-btn va-focus flex w-full items-center justify-center rounded-lg py-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
          >
            <ChevronLeft
              size={15}
              className={
                "transition-transform duration-500 " + (collapsed ? "rotate-180" : "")
              }
              style={{ transitionTimingFunction: "var(--ease-spring)" }}
            />
          </button>
        </div>
      </aside>

      {/* ------------------------------------------------------------- Workspace */}
      <main className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="va-glass sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight">Workspace</h1>
            <p className="truncate text-[11px] text-muted">
              Chat, screen vision, voice, and approval-gated automation — all against your
              own key.
            </p>
          </div>
          <div className="ml-auto w-full sm:w-auto sm:min-w-[320px]">
            <SegmentedControl segments={SEGMENTS} value={view} onChange={setView} />
          </div>
        </header>

        <div
          className={
            "min-h-0 flex-1 gap-4 overflow-y-auto p-4 " +
            (grid
              ? "grid auto-rows-[minmax(300px,auto)] grid-cols-1 lg:grid-cols-12"
              : "flex")
          }
        >
          {(grid || view === "vision") && (
            <Panel
              icon={MonitorPlay}
              title="Screen Vision"
              badge="M2 · frame eviction"
              delay={1}
              focused={view === "vision"}
              onToggleFocus={focusToggle("vision")}
              className={grid ? "lg:col-span-7 lg:row-span-2" : "flex-1"}
            >
              <ScreenCapturePanel />
            </Panel>
          )}

          {(grid || view === "chat") && (
            <Panel
              icon={MessageSquareCode}
              title="Model Test Console"
              badge="text only"
              delay={2}
              focused={view === "chat"}
              onToggleFocus={focusToggle("chat")}
              className={grid ? "lg:col-span-5" : "flex-1"}
            >
              <TestConsole />
            </Panel>
          )}

          {(grid || view === "voice") && (
            <Panel
              icon={Waves}
              title="Voice"
              badge="M3 · VAD + interrupt"
              delay={3}
              focused={view === "voice"}
              onToggleFocus={focusToggle("voice")}
              className={grid ? "lg:col-span-5" : "flex-1"}
            >
              <VoicePanel />
            </Panel>
          )}

          {(grid || view === "auto") && (
            <Panel
              icon={MousePointerClick}
              title="On-Screen Automation"
              badge="M4 · approval required"
              delay={4}
              focused={view === "auto"}
              onToggleFocus={focusToggle("auto")}
              className={grid ? "lg:col-span-12" : "flex-1"}
            >
              <AutomationPanel />
            </Panel>
          )}
        </div>
      </main>

      {showKeys && <ApiKeyModal onClose={() => setShowKeys(false)} />}
    </div>
  );
}
