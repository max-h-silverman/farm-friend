"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * The "Details & settings" tab, as ONE screen with ONE commit (F-098).
 *
 * max, reading the live page 2026-08-09: the tab carried three buttons that committed
 * something — the listing's, the onboarding wizard's "Submit" (rendered because the editing
 * door has no steps and that button was never gated on the credential), and the settings
 * panel's. F-097 unified the buttons INSIDE the settings panel and left the composition alone,
 * so the wizard's Submit survived beside the panel that replaced it.
 *
 * **This joins the two panels without merging their writers.** The listing form owns the one
 * button; the settings panel hands its save up through `registerSave`, and the listing form
 * runs it on the same press. Merging the requests themselves would put the participant write —
 * which carries its own audit event and its own public-text refusal — behind the listing's
 * transaction, which is a different act with a different provenance.
 *
 * ## Why CONTEXT rather than render props
 *
 * The obvious shape is `renderListing={(alsoSave) => …}`. It cannot work: this tab is composed
 * by a SERVER component, and React refuses to pass a function across that boundary
 * ("Functions cannot be passed directly to Client Components"). The jsdom suite could not see
 * it — there both panels are plain components and the boundary does not exist — so it rendered
 * green while every real request 500'd. The deployed runtime is the only place that fact lives.
 *
 * So the panels are ordinary children and reach the shared save through a hook. Nothing crosses
 * the server/client boundary but elements.
 */
export interface TabCommit {
  /** Runs the settings panel's save. Resolves to whether it SUCCEEDED. */
  alsoSave: () => Promise<boolean>;
  /** How the settings panel hands its save up. */
  registerSave: (save: () => Promise<boolean>) => void;
}

const TabCommitContext = createContext<TabCommit | null>(null);

/**
 * The tab's shared commit, for a panel rendered inside it.
 *
 * Returns `null` outside a `DetailsPanel` — the standalone `/stand/[token]/listing` and
 * `/stand/[token]/settings` pages, which a farmer may have bookmarked and which Farm Friend's
 * own SMS replies name. Those keep their own buttons, so a panel must work with no tab at all.
 */
export function useTabCommit(): TabCommit | null {
  return useContext(TabCommitContext);
}

export function DetailsPanel({ children }: { children: ReactNode }) {
  /**
   * The settings panel's save, as it stands on the CURRENT render.
   *
   * A ref rather than state: storing it in state would re-render on registration, and reading
   * it at call time is what keeps the press posting what is on screen now rather than what the
   * panel closed over when the tab mounted.
   */
  const settingsSave = useRef<(() => Promise<boolean>) | null>(null);

  const registerSave = useCallback((save: () => Promise<boolean>) => {
    settingsSave.current = save;
  }, []);

  const alsoSave = useCallback(async () => {
    // No panel registered — a farm whose settings did not load. Nothing to save is not a
    // failure, and reporting one would block a listing edit over an absent panel.
    if (settingsSave.current === null) return true;
    return settingsSave.current();
  }, []);

  // Stable across renders, so a panel reading it does not re-subscribe on every keystroke.
  const [value] = useState<TabCommit>(() => ({ alsoSave, registerSave }));

  return <TabCommitContext.Provider value={value}>{children}</TabCommitContext.Provider>;
}
