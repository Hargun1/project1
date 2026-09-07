/** Identity reported by /healthz and in log lines. */
export const SERVICE_NAME = 'collab-editor-backend';

export const SERVICE_VERSION = '0.1.0';

/** Request body cap (§12 "request size limits"). Yjs updates travel over WS, not REST. */
export const JSON_BODY_LIMIT = '100kb';
