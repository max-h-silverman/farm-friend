// Farm Friend core domain — framework-agnostic logic behind injected provider seams.

export * from "./clock";
export * from "./map";
export * from "./privacy/phone";
export * from "./sms/commands";
export * from "./inventory/proposal";
// The generic commitment state machine is superseded by the inventory-specific proposal
// port above and has no authoritative caller. Its removal — with the OUT/IGNORE tokens
// it accepts — belongs to F-012's parser/campaign alignment, which also owns the eval
// fixtures that still exercise it.
export * from "./commitment/state-machine";
export * from "./farmstand/stockout";
export * from "./auth/magic-link";
export * from "./auth/roles";
