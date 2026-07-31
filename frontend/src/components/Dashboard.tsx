"use client";

import { useState } from "react";
import {
  KeyRound,
  Lock,
  MessageSquareCode,
  MonitorPlay,
  MousePointerClick,
  ShieldCheck,
  Waves,
} from "lucide-react";
import ApiKeyModal from "./ApiKeyModal";
import ModelSwitcher from "./ModelSwitcher";
import ScreenCapturePanel from "./ScreenCapturePanel";
import TestConsole from "./TestConsole";
import { useVault } from "./vault-context";

/** Placeholder for a workspace panel that lands in a later milestone. */
function ComingSoon({
  icon,
  title,
  milestone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  milestone: string;
  children: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface/50 p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <span className="text-accent">{icon}</span>
        {title}
        <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          {milestone}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted">{children}</p>
    </div>
  );
}

export default function Dashboard() {
  const { lock, configured } = useVault();
  const [showKeys, setShowKeys] = useState(false);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="flex w-72 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <ShieldCheck size={18} />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">VisionAssist AI</div>
            <div className="text-[11px] text-muted">BYOK · privacy-first</div>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <ModelSwitcher />

          <button
            onClick={() => setShowKeys(true)}
            className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm transition hover:border-accent"
          >
            <KeyRound size={15} className="text-accent" />
            Manage API keys
            <span className="ml-auto text-xs text-muted">
              {configured.length} set
            </span>
          </button>
        </div>

        <div className="border-t border-border p-5">
          <button
            onClick={lock}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition hover:border-danger hover:text-danger"
          >
            <Lock size={15} /> Lock vault
          </button>
        </div>
      </aside>

      {/* Main workspace */}
      <main className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h1 className="text-base font-semibold">Workspace</h1>
            <p className="text-xs text-muted">
              Test your model now — capture, voice, and automation land in upcoming milestones.
            </p>
          </div>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-6 lg:grid-cols-2">
          {/* Live model test console (Milestone 1) */}
          <section className="flex min-h-[420px] flex-col overflow-hidden rounded-xl border border-border bg-surface">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-medium">
              <MessageSquareCode size={16} className="text-accent" />
              Model Test Console
            </div>
            <TestConsole />
          </section>

          {/* Screen capture + vision-over-WebSocket (Milestone 2) */}
          <section className="flex min-h-[420px] flex-col overflow-hidden rounded-xl border border-border bg-surface">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-medium">
              <MonitorPlay size={16} className="text-accent" />
              Screen Vision
              <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                M2 · frame eviction
              </span>
            </div>
            <ScreenCapturePanel />
          </section>

          {/* Roadmap panels */}
          <section className="space-y-4 lg:col-span-2">
            <ComingSoon
              icon={<Waves size={16} />}
              title="Full-Duplex Voice"
              milestone="M3"
            >
              Talk to the assistant with client-side VAD and mid-sentence interruption; STT
              and TTS stream over the WebSocket pipeline.
            </ComingSoon>
            <ComingSoon
              icon={<MousePointerClick size={16} />}
              title="On-Screen Automation"
              milestone="M4"
            >
              The model grounds UI targets to coordinates; Playwright or a local daemon
              executes clicks and typing behind an approval queue.
            </ComingSoon>
          </section>
        </div>
      </main>

      {showKeys && <ApiKeyModal onClose={() => setShowKeys(false)} />}
    </div>
  );
}
