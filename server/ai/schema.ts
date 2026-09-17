import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  AdvisorInput,
  AdvisorOutput,
  EvaluatorInput,
  EvaluatorOutput,
  AgentJobView,
} from "./types.js";

export class AiContractError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AiContractError";
  }
}
export function ensure(value: unknown, code: string): asserts value {
  if (!value) throw new AiContractError(code);
}
export const agentSchema = JSON.parse(
  readFileSync(
    new URL("./assets/contracts.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: true,
});
addFormats(ajv);
ajv.addSchema(agentSchema, "last-mile-agents");
interface ContractMap {
  AdvisorInput: AdvisorInput;
  AdvisorOutput: AdvisorOutput;
  EvaluatorInput: EvaluatorInput;
  EvaluatorOutput: EvaluatorOutput;
  AgentJobView: AgentJobView;
}
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function assertContract<K extends keyof ContractMap>(
  name: K,
  value: unknown,
): asserts value is ContractMap[K] {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `last-mile-agents#/$defs/${name}` });
    validators.set(name, validate);
  }
  if (!validate(value)) throw new AiContractError(`SCHEMA_${name}`);
}

/** Both providers receive a deliberately weaker grammar; ALL full-schema and
 * contextual constraints remain mandatory locally. No conditional keyword is
 * silently treated as a business guarantee from the provider. */
export function providerOutputSchema(
  role: "advisor" | "evaluator",
): Record<string, unknown> {
  const visit = (node: any, path: Set<string> = new Set()): any => {
    if (node.$ref) {
      ensure(node.$ref.startsWith("#/$defs/"), "EXTERNAL_SCHEMA_REF");
      ensure(!path.has(node.$ref), "RECURSIVE_SCHEMA_UNSUPPORTED");
      return visit(
        agentSchema.$defs[node.$ref.slice(8)],
        new Set([...path, node.$ref]),
      );
    }
    const result: any = {};
    if (node.type) result.type = node.type;
    if (node.const !== undefined) {
      result.enum = [node.const];
      result.type ??=
        typeof node.const === "boolean"
          ? "boolean"
          : typeof node.const === "number"
            ? "integer"
            : "string";
    }
    if (node.enum) {
      result.enum = node.enum;
      result.type ??= typeof node.enum[0] === "string" ? "string" : "integer";
    }
    if (node.anyOf) result.anyOf = node.anyOf.map((x: any) => visit(x, path));
    if (node.properties) {
      result.type = "object";
      result.properties = Object.fromEntries(
        Object.entries(node.properties).map(([k, v]) => [k, visit(v, path)]),
      );
      result.required = Object.keys(node.properties);
      result.additionalProperties = false;
    }
    if (node.items) {
      result.type = "array";
      result.items = visit(node.items, path);
    }
    const local = [
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
      "uniqueItems",
    ]
      .filter((k) => node[k] !== undefined)
      .map((k) => `${k}=${JSON.stringify(node[k])}`);
    if (local.length)
      result.description = `Application constraints, checked after generation: ${local.join("; ")}.`;
    return result;
  };
  return visit(
    agentSchema.$defs[role === "advisor" ? "AdvisorOutput" : "EvaluatorOutput"],
  );
}
