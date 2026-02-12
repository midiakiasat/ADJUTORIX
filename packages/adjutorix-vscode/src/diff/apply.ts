import { rpc } from "../client/rpc";

export type ApplyResult = {
  ok: boolean;
  applied: number;
  errors: string[];
};

export type FsOp = {
  op: "write" | "delete" | "mkdir" | "chmod" | "rename";
  path: string;
  to?: string;
  content_b64?: string;
  mode?: number;
};

/**
 * UI must never write locally.
 * It sends ops to the agent apply endpoint and renders the result.
 */
export async function applyPatch(sessionId: string, ops: FsOp[]): Promise<ApplyResult> {
  return rpc<ApplyResult>("fs.applyPatch", { session_id: sessionId, ops });
}
