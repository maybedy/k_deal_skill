/** A refusal by the usage gateway (limits, scope, key policy). Returned to the caller as a tool error, never as data. */
export class GatewayDenied extends Error {
  constructor(code, message) { super(message); this.name = 'GatewayDenied'; this.code = code; }
}
