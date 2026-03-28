// packages/shared/src/rpc/validation.ts
import { RPC_METHOD_SCHEMAS } from "./schema.js";
import type { RpcFieldSchema } from "./schema.js";
import { isRpcMethod, JSON_RPC_VERSION } from "./protocol.js";
import type { RpcMethod, RpcRequestEnvelope, RpcResponseEnvelope } from "./protocol.js";
import type { RpcRequestParamsByMethod } from "./requests.js";
import type { RpcResponseResultByMethod } from "./responses.js";

/** Assert value is a non-null object */
function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

/** Assert value is a non-empty string */
function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

/** Assert value is a finite number */
function assertNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${field} must be a finite number`);
  }
}

/** Assert value is boolean */
function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
}

/** Validate value against RpcFieldSchema recursively */
function validateBySchema(value: unknown, schema: RpcFieldSchema, field: string): void {
  if (schema.type === "optional") {
    if (value === undefined) return;
    validateBySchema(value, schema.items!, field);
    return;
  }

  switch (schema.type) {
    case "string":
      assertString(value, field);
      return;
    case "number":
      assertNumber(value, field);
      return;
    case "boolean":
      assertBoolean(value, field);
      return;
    case "array":
      if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
      value.forEach((item, index) => validateBySchema(item, schema.items!, `${field}[${index}]`));
      return;
    case "object": {
      assertObject(value, field);
      const props = schema.properties ?? {};
      for (const [key, propSchema] of Object.entries(props)) {
        validateBySchema(value[key], propSchema, `${field}.${key}`);
      }
      return;
    }
    case "union":
      if (typeof value !== "string" || !(schema.values ?? []).includes(value)) {
        throw new Error(`${field} must be one of ${(schema.values ?? []).join(", ")}`);
      }
      return;
    default:
      throw new Error(`unsupported schema type at ${field}`);
  }
}

/** Validate RPC request envelope */
export function validateRequestEnvelope(value: unknown): asserts value is RpcRequestEnvelope {
  assertObject(value, "request");
  if (value.jsonrpc !== JSON_RPC_VERSION) {
    throw new Error(`request.jsonrpc must equal ${JSON_RPC_VERSION}`);
  }
  if (!("id" in value)) {
    throw new Error("request.id must be present");
  }
  assertString(value.method, "request.method"); // ✅ Ensure string before `isRpcMethod`
  if (!isRpcMethod(value.method)) {
    throw new Error(`unsupported request.method: ${value.method}`);
  }
  validateRequestParams(value.method, value.params);
}

/** Validate RPC response envelope */
export function validateResponseEnvelope(value: unknown, method: RpcMethod): asserts value is RpcResponseEnvelope {
  assertObject(value, "response");
  if (value.jsonrpc !== JSON_RPC_VERSION) {
    throw new Error(`response.jsonrpc must equal ${JSON_RPC_VERSION}`);
  }

  if ("error" in value && value.error !== undefined) {
    assertObject(value.error, "response.error");
    assertNumber(value.error.code, "response.error.code");
    assertString(value.error.type, "response.error.type");
    assertString(value.error.message, "response.error.message");
    return;
  }

  if (!("result" in value)) {
    throw new Error("response.result must be present");
  }
  validateResponseResult(method, value.result);
}

/** Validate request parameters by schema */
export function validateRequestParams<M extends RpcMethod>(
  method: M,
  params: unknown
): asserts params is RpcRequestParamsByMethod[M] {
  const schema = RPC_METHOD_SCHEMAS[method].request;
  validateBySchema(params, schema, `${method}.params`);
}

/** Validate response result by schema */
export function validateResponseResult<M extends RpcMethod>(
  method: M,
  result: unknown
): asserts result is RpcResponseResultByMethod[M] {
  const schema = RPC_METHOD_SCHEMAS[method].response;
  validateBySchema(result, schema, `${method}.result`);
}