export * from "./redaction";
export * from "./segments";
export * from "./scheduled-prompt-segments";
export * from "./telnyx";
export * from "./delivery";
export * from "./provider-error";

// The SMS package's outbound surface is `./delivery`: `createLastMileSender` takes a
// `ProviderTransport`, and the web composition root wires the real Telnyx transport into
// it. There is ONE send seam (GL-035).
//
// A second one used to live here — `SmsTransport`/`OutboundMessage`/`SmsSimulator` plus a
// metrics logger only the simulator called. Nothing in production referenced any of it; it
// was reachable only from this package's own tests, and it was where the outbound compile
// guard was asserted, so the safety proof described a path that never ran. Deleted rather
// than kept as a test double: `createLastMileSender`'s seam is a plain function, so a test
// fake for it is one arrow function, not a class.
//
// `estimateSmsSegments` and `normalizeAvoidableSmsUnicode` survive in `./segments` and are
// NOT part of what was removed. The normalizer is on the real path already (the outbound
// guard calls it); the estimator is the machinery GL-021 attaches to the real send path.
