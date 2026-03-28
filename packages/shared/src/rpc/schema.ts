import type { RpcMethod } from "./protocol.js";

export interface RpcFieldSchema {
  readonly type:
    | "string"
    | "number"
    | "boolean"
    | "object"
    | "array"
    | "union"
    | "optional";
  readonly values?: readonly string[];
  readonly properties?: Readonly<Record<string, RpcFieldSchema>>;
  readonly items?: RpcFieldSchema;
}

export interface RpcMethodSchema {
  readonly request: RpcFieldSchema;
  readonly response: RpcFieldSchema;
}

const stringField = (): RpcFieldSchema => ({ type: "string" });
const numberField = (): RpcFieldSchema => ({ type: "number" });
const booleanField = (): RpcFieldSchema => ({ type: "boolean" });
const optionalField = (inner: RpcFieldSchema): RpcFieldSchema => ({ type: "optional", items: inner });
const arrayField = (inner: RpcFieldSchema): RpcFieldSchema => ({ type: "array", items: inner });
const objectField = (properties: Record<string, RpcFieldSchema>): RpcFieldSchema => ({
  type: "object",
  properties
});
const unionField = (values: readonly string[]): RpcFieldSchema => ({ type: "union", values });

export const RPC_METHOD_SCHEMAS: Readonly<Record<RpcMethod, RpcMethodSchema>> = {
  "system.health": {
    request: objectField({
      nonce: stringField(),
      requestedAt: stringField()
    }),
    response: objectField({
      ok: booleanField(),
      nonce: stringField(),
      respondedAt: stringField(),
      serverTime: stringField()
    })
  },
  "workspace.open": {
    request: objectField({
      path: stringField(),
      trusted: optionalField(booleanField()),
      reindex: optionalField(booleanField())
    }),
    response: objectField({
      workspaceId: stringField(),
      path: stringField(),
      trusted: booleanField(),
      indexState: unionField(["missing", "building", "ready"])
    })
  },
  "workspace.scan": {
    request: objectField({
      workspaceId: stringField(),
      includeHidden: optionalField(booleanField()),
      maxFiles: optionalField(numberField())
    }),
    response: objectField({
      workspaceId: stringField(),
      fileCount: numberField(),
      ignoredCount: numberField(),
      diagnosticCount: numberField()
    })
  },
  "ledger.current": {
    request: objectField({
      workspaceId: stringField()
    }),
    response: objectField({
      workspaceId: stringField(),
      headSequence: numberField(),
      latestTransactionId: optionalField(stringField())
    })
  },
  "ledger.range": {
    request: objectField({
      workspaceId: stringField(),
      fromSequence: optionalField(numberField()),
      toSequence: optionalField(numberField()),
      limit: optionalField(numberField())
    }),
    response: objectField({
      workspaceId: stringField(),
      transactions: arrayField(objectField({})),
      artifacts: arrayField(objectField({})),
      edges: arrayField(objectField({}))
    })
  },
  "patch.validate": {
    request: objectField({
      workspaceId: stringField(),
      artifactPath: stringField(),
      basisSequence: optionalField(numberField()),
      strict: optionalField(booleanField())
    }),
    response: objectField({
      patchId: stringField(),
      valid: booleanField(),
      conflicts: arrayField(stringField()),
      summary: stringField()
    })
  },
  "patch.apply": {
    request: objectField({
      workspaceId: stringField(),
      patchId: stringField(),
      confirmationToken: optionalField(stringField()),
      dryRun: optionalField(booleanField())
    }),
    response: objectField({
      transactionId: stringField(),
      state: unionField(["scheduled", "running", "applied", "failed"]),
      dryRun: booleanField(),
      previewArtifacts: arrayField(stringField())
    })
  },
  "patch.reject": {
    request: objectField({
      workspaceId: stringField(),
      patchId: stringField(),
      reason: stringField()
    }),
    response: objectField({
      patchId: stringField(),
      rejected: booleanField(),
      reason: stringField()
    })
  },
  "patch.rollback": {
    request: objectField({
      workspaceId: stringField(),
      transactionId: stringField(),
      targetSequence: optionalField(numberField())
    }),
    response: objectField({
      transactionId: stringField(),
      rollbackTransactionId: stringField()
    })
  },
  "verify.run": {
    request: objectField({
      workspaceId: stringField(),
      scope: unionField(["workspace", "selection", "transaction"]),
      targets: optionalField(arrayField(stringField())),
      transactionId: optionalField(stringField())
    }),
    response: objectField({
      verificationId: stringField(),
      transactionId: optionalField(stringField()),
      status: unionField(["queued", "running", "completed"])
    })
  },
  "verify.status": {
    request: objectField({
      verificationId: stringField()
    }),
    response: objectField({
      verificationId: stringField(),
      status: unionField(["queued", "running", "completed", "failed"]),
      summaryArtifactId: optionalField(stringField())
    })
  },
  "recovery.resume": {
    request: objectField({
      workspaceId: stringField(),
      transactionId: optionalField(stringField())
    }),
    response: objectField({
      workspaceId: stringField(),
      resumedTransactionId: optionalField(stringField()),
      status: unionField(["idle", "resumed", "nothing-to-resume"])
    })
  },
  "governance.check": {
    request: objectField({
      workspaceId: stringField(),
      target: stringField(),
      operation: stringField()
    }),
    response: objectField({
      allowed: booleanField(),
      reasons: arrayField(stringField())
    })
  },
  "diagnostics.parse": {
    request: objectField({
      tool: stringField(),
      rawOutput: stringField()
    }),
    response: objectField({
      tool: stringField(),
      problemCount: numberField(),
      problems: arrayField(objectField({}))
    })
  },
  "transaction.status": {
    request: objectField({
      transactionId: stringField()
    }),
    response: objectField({
      transactionId: stringField(),
      state: stringField()
    })
  }
};
