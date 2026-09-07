// Exhaustiveness-check helper (plan.md M13: "Exhaustiveness typing"). Call it
// from a switch's `default` branch after casting the scrutinee to a declared
// literal-union type (e.g. schema.ts's `BlockNodeName`) — if a case is
// missing, the value's type in `default` still includes that unhandled
// literal, so the call fails to *compile* instead of only failing the first
// time that code path runs.
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
