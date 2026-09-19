# Contract entry points

- `../api/openapi.json`: OpenAPI 3.1.1, 23 HTTP operations. Every gameplay POST uses strict request schemas, local authorization and idempotency.
- `public.schema.json#/$defs/<Type>`: public command/projection/SSE schema. The root is a convenience union, not the validator for every record type.
- `internal.schema.json#/$defs/InternalEvent`: private gameplay-only union; its sequence is immutable after terminal seal. Advisor lifecycle only.
- `internal.schema.json#/$defs/PostgameAuditEvent`: separate sealed-session management audit union for fact building, evaluator lifecycle and exports. No gameplay sequence or mission clock; `AuditStorePort` persists it separately.
- `../agents/contracts.schema.json`: canonical Agent contracts; no duplicate Agent schema here.
- `ports.ts`: shared module interfaces. No game implementation.
- `generate_types.py`: derive TS from canonical schemas; `--check` verifies no drift. `content-derived.types.ts` is server-only.
- `fixtures/*-cases.json`: positive and negative shape tests. Cross-record permissions and state transitions require runtime integration tests.

Run the commands in `../04_LLD_API与契约.md`. All `$ref` targets are local files. New source metadata must not silently become public metadata.

Current mission timing semantics (policy `0.6.0`): `missionDeadlineMs: null`
means there is no overall mission time limit. `missionTimeMs` still records
elapsed time, and investigations, movement and waiting retain their durations.
The private policy sets `missionDurationMs` and `medicalSupportAtMs` to `null`,
disabling both the overall deadline and the elapsed-time medical penalty;
`outcomeSuccess: "arrival_N07"` has no deadline condition. Non-negative numeric
deadlines, the legacy success rule, and historical deadline/medical events
remain valid for stored records. Fixtures cover both policy generations.
