export const RPC_CHANNELS = {
  request: "adjutorix:rpc:request",
  response: "adjutorix:rpc:response",
  notifications: "adjutorix:rpc:notifications",
  diagnostics: "adjutorix:rpc:diagnostics",
  ledger: "adjutorix:rpc:ledger",
  verify: "adjutorix:rpc:verify"
} as const;

export type RpcChannelName = (typeof RPC_CHANNELS)[keyof typeof RPC_CHANNELS];

export function isRpcChannelName(value: string): value is RpcChannelName {
  return (Object.values(RPC_CHANNELS) as readonly string[]).includes(value);
}
