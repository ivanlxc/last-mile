import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export interface ContractOperation {
  method: "GET" | "POST";
  path: string;
  operationId: string;
  request: string | null;
  response: string;
  status: number;
}
interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema: object;
}
interface OpenApiOperation {
  parameters?: Array<Parameter | { $ref: string }>;
}
interface Spec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { parameters: Record<string, Parameter> };
}

const PUBLIC_ID = "https://last-mile.local/contracts/public.schema.json";
const AGENT_ID = "https://last-mile.local/agents/contracts.schema.json";

export class ContractRegistry {
  readonly operations: ContractOperation[];
  private readonly ajv: Ajv2020;
  private readonly spec: Spec;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(repoRoot: string) {
    const dir = resolve(repoRoot, "docs/engineering_v0.5");
    const parse = (path: string): unknown =>
      JSON.parse(readFileSync(resolve(dir, path), "utf8"));
    this.operations = parse("api/operations.json") as ContractOperation[];
    this.spec = parse("api/openapi.json") as Spec;
    this.ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
    });
    addFormats(this.ajv);
    this.ajv.addSchema({
      ...(parse("agents/contracts.schema.json") as object),
      $id: AGENT_ID,
    });
    this.ajv.addSchema({
      ...(parse("contracts/public.schema.json") as object),
      $id: PUBLIC_ID,
    });
    for (const op of this.operations) {
      if (op.request) this.validator(op.request);
      if (op.operationId !== "streamEvents")
        this.validator(this.responseName(op));
    }
    this.validator("PublicSseEvent");
    this.validator("Problem");
  }

  responseName(op: ContractOperation): string {
    return op.operationId === "getAdvice"
      ? "AdvisorJobView"
      : op.operationId === "getEvaluation"
        ? "EvaluationJobView"
        : op.response;
  }

  validator(name: string): ValidateFunction {
    let validator = this.validators.get(name);
    if (!validator) {
      validator = this.ajv.compile({ $ref: `${PUBLIC_ID}#/$defs/${name}` });
      this.validators.set(name, validator);
    }
    return validator;
  }

  errors(name: string, value: unknown): ErrorObject[] {
    const validator = this.validator(name);
    return validator(value) ? [] : [...(validator.errors ?? [])];
  }

  requestErrors(
    op: ContractOperation,
    body: unknown,
    params: unknown,
    query: unknown,
    headers: Record<string, unknown>,
  ): ErrorObject[] {
    const errors: ErrorObject[] = [];
    if (op.request) errors.push(...this.errors(op.request, body));
    else if (body !== undefined)
      errors.push({
        instancePath: "/body",
        schemaPath: "",
        keyword: "additionalProperties",
        params: {},
      });
    const relative = op.path.slice("/api/v1".length);
    const specOp = this.spec.paths[relative]?.[op.method.toLowerCase()];
    const defs = (specOp?.parameters ?? []).map((p) =>
      "$ref" in p
        ? this.spec.components.parameters[p.$ref.split("/").at(-1)!]!
        : p,
    );
    for (const location of ["path", "query", "header"] as const) {
      const relevant = defs.filter((p) => p.in === location);
      const source =
        location === "path" ? params : location === "query" ? query : headers;
      const properties: Record<string, object> = {};
      const required: string[] = [];
      for (const p of relevant) {
        const key = location === "header" ? p.name.toLowerCase() : p.name;
        properties[key] = p.schema;
        if (p.required) required.push(key);
      }
      const key = `${op.operationId}:${location}`;
      let validate = this.validators.get(key);
      if (!validate) {
        validate = this.ajv.compile({
          type: "object",
          properties,
          required,
          additionalProperties: location === "header",
        });
        this.validators.set(key, validate);
      }
      if (!validate(source))
        errors.push(
          ...(validate.errors ?? []).map((e) => ({
            ...e,
            instancePath: `/${location}${e.instancePath}`,
          })),
        );
    }
    const q = query as Record<string, unknown>;
    if (
      op.operationId === "streamEvents" &&
      q.after !== undefined &&
      headers["last-event-id"] !== undefined
    ) {
      errors.push({
        instancePath: "/query/after",
        schemaPath: "",
        keyword: "oneOf",
        params: {},
      });
    }
    return errors;
  }
}
