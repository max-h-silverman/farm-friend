// @vitest-environment jsdom

import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  EMBED_HEIGHT_MESSAGE,
  EmbedHeightReporter,
} from "../app/embed-height";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "parent", { configurable: true, value: window });
});

describe("the shared iframe height handshake", () => {
  it("reports the document height when embedded and whenever its layout changes", async () => {
    const postMessage = vi.fn();
    let resized: (() => void) | undefined;
    class ResizeObserverStub {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    }

    Object.defineProperty(window, "parent", {
      configurable: true,
      value: { postMessage },
    });
    let contentHeight = 777;
    vi.spyOn(document.body, "getBoundingClientRect").mockImplementation(
      () => ({ height: contentHeight }) as DOMRect,
    );
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    render(<EmbedHeightReporter />);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { type: EMBED_HEIGHT_MESSAGE, height: 777 },
        "*",
      );
    });
    postMessage.mockClear();
    contentHeight = 420;
    resized?.();
    expect(postMessage).toHaveBeenCalledWith(
      { type: EMBED_HEIGHT_MESSAGE, height: 420 },
      "*",
    );
  });

  it("is mounted once in the shared layout, not only on the public map", () => {
    const layout = readFileSync(resolve("apps/web/app/layout.tsx"), "utf8");
    const mapPage = readFileSync(resolve("apps/web/app/page.tsx"), "utf8");

    expect(layout).toMatch(/<body>\s*<EmbedHeightReporter\s*\/>\s*\{children\}\s*<\/body>/);
    expect(mapPage).not.toMatch(/<EmbedHeightReporter\s*\/>/);
  });
});
