import { describe, expect, it } from "vitest";
import { parseSmsCommand } from "./commands.js";

describe("parseSmsCommand", () => {
  it("parses compliance keywords before any model can see them", () => {
    expect(parseSmsCommand("STOP")).toEqual({ kind: "stop" });
    expect(parseSmsCommand(" unsubscribe ")).toEqual({ kind: "stop" });
    expect(parseSmsCommand("START")).toEqual({ kind: "start" });
    expect(parseSmsCommand("join")).toEqual({ kind: "join" });
    expect(parseSmsCommand("help")).toEqual({ kind: "help" });
    expect(parseSmsCommand("INFO")).toEqual({ kind: "help" });
    expect(parseSmsCommand("FLAG wrong farm")).toEqual({ kind: "flag" });
  });

  it("catches punctuation and unicode variants of deterministic keywords", () => {
    expect(parseSmsCommand("ＳＴＯＰ")).toEqual({ kind: "stop" });
    expect(parseSmsCommand("(STOP)")).toEqual({ kind: "stop" });
    expect(parseSmsCommand("HELP?")).toEqual({ kind: "help" });
    expect(parseSmsCommand("YES!")).toEqual({ kind: "yes" });
  });

  it("keeps YES and NO context-bound for the router", () => {
    expect(parseSmsCommand("YES")).toEqual({ kind: "yes" });
    expect(parseSmsCommand("NO")).toEqual({ kind: "no" });
    expect(parseSmsCommand("YES, 10-1 works")).toEqual({ kind: "yes" });
  });

  it("does not treat keywords in the middle of normal text as commands", () => {
    expect(parseSmsCommand("I can stop by tomorrow")).toEqual({ kind: "none" });
    expect(parseSmsCommand("please help me find kale")).toEqual({ kind: "none" });
  });
});
