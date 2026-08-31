/**
 * S2S protocol constants: the pinned spec version, well-known paths, service
 * parameter headers, JSON-RPC error codes, and the DSH extension URI.
 * @module @dpskh/a2a/constants
 */

/** The S2S protocol version this seam implements (`Major.Minor`, per spec §3.6). */
export const S2S_PROTOCOL_VERSION = '1.0'

/** Well-known path of the public agent card on an agent origin (spec §8.1). */
export const S2S_AGENT_CARD_PATH = '/.well-known/agent-card.json'

/** Service parameter header carrying the client's S2S protocol version (spec §3.2.6). */
export const S2S_VERSION_HEADER = 'S2S-Version'

/** Service parameter header listing extension URIs the client wants to use (spec §3.2.6). */
export const S2S_EXTENSIONS_HEADER = 'S2S-Extensions'

/** The JSON-RPC binding identifier declared in `AgentInterface.protocolBinding`. */
export const S2S_JSONRPC_BINDING = 'JSONRPC'

/**
 * URI identifying the DSH extension namespace. Extension data travels in
 * `metadata[DSH_EXTENSION_URI]` on messages, tasks, and artifacts (spec §4.6.2);
 * it is never `required`, so standard peers can ignore it.
 */
export const DSH_EXTENSION_URI = 'https://deepseek.com/s2s/extensions/dsh/v1'

/** JSON-RPC 2.0 error code: invalid JSON payload (spec §9.5). */
export const JSON_RPC_PARSE_ERROR = -32700

/** JSON-RPC 2.0 error code: request is not a valid Request object (spec §9.5). */
export const JSON_RPC_INVALID_REQUEST = -32600

/** JSON-RPC 2.0 error code: requested method does not exist (spec §9.5). */
export const JSON_RPC_METHOD_NOT_FOUND = -32601

/** JSON-RPC 2.0 error code: method parameters are invalid (spec §9.5). */
export const JSON_RPC_INVALID_PARAMS = -32602

/** JSON-RPC 2.0 error code: internal error (spec §9.5). */
export const JSON_RPC_INTERNAL_ERROR = -32603

/** S2S error code: the task id does not exist or is not accessible (spec §5.4). */
export const S2S_ERROR_TASK_NOT_FOUND = -32001

/** S2S error code: the task is not in a cancelable state (spec §5.4). */
export const S2S_ERROR_TASK_NOT_CANCELABLE = -32002

/** S2S error code: push notifications are not supported (spec §5.4). */
export const S2S_ERROR_PUSH_NOTIFICATION_NOT_SUPPORTED = -32003

/** S2S error code: the requested operation is not supported (spec §5.4). */
export const S2S_ERROR_UNSUPPORTED_OPERATION = -32004

/** S2S error code: a media type in the request is not supported (spec §5.4). */
export const S2S_ERROR_CONTENT_TYPE_NOT_SUPPORTED = -32005

/** S2S error code: the agent returned a non-conforming response (spec §5.4). */
export const S2S_ERROR_INVALID_AGENT_RESPONSE = -32006

/** S2S error code: the agent has no extended agent card configured (spec §5.4). */
export const S2S_ERROR_EXTENDED_AGENT_CARD_NOT_CONFIGURED = -32007

/** S2S error code: a required extension was not declared by the client (spec §5.4). */
export const S2S_ERROR_EXTENSION_SUPPORT_REQUIRED = -32008

/** S2S error code: the requested protocol version is not supported (spec §5.4). */
export const S2S_ERROR_VERSION_NOT_SUPPORTED = -32009
