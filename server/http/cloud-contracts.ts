import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  removeAdditional: false,
  coerceTypes: false,
});
addFormats(ajv);
export const validAccessRequest = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["inviteCode"],
  properties: { inviteCode: { type: "string", minLength: 1, maxLength: 256 } },
});
export const validSessionList = ajv.compile({
  type: "array",
  maxItems: 100,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "locale", "status", "createdAt", "updatedAt"],
    properties: {
      sessionId: { type: "string", format: "uuid" },
      locale: { enum: ["en-US", "zh-CN"] },
      status: { enum: ["created", "active", "sealed"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
});
