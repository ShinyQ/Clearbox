// Microsoft identity platform and Graph wire types (research mail-providers.md section 8, plus
// conversationIndex and sentDateTime, which Clearbox selects).

export interface MsTokenResponse {
  token_type: "Bearer";
  scope: string;
  expires_in: number;
  ext_expires_in?: number;
  access_token: string;
  /** Returned on every refresh: persist it (rotation). */
  refresh_token?: string;
}

export interface MsOAuthError {
  error: string;
  error_description: string;
  error_codes?: number[];
  timestamp?: string;
  trace_id?: string;
  correlation_id?: string;
  suberror?: string;
}

export interface GraphMe {
  id: string;
  mail: string | null;
  userPrincipalName: string;
  displayName?: string | null;
}

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress: GraphEmailAddress;
}

export interface GraphHeader {
  name: string;
  value: string;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  /** Base64 PidTagConversationIndex: 22-byte header + 5 bytes per reply level. */
  conversationIndex?: string;
  internetMessageId?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  subject?: string | null;
  bodyPreview?: string;
  isRead?: boolean;
  importance?: "low" | "normal" | "high";
  hasAttachments?: boolean;
  inferenceClassification?: "focused" | "other";
  flag?: { flagStatus: "notFlagged" | "complete" | "flagged" };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  parentFolderId?: string;
  webLink?: string;
  internetMessageHeaders?: GraphHeader[];
  "@removed"?: { reason: string };
}

export interface GraphCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface GraphMailFolder {
  id: string;
  displayName: string;
}

export interface GraphBatchSubRequest {
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  dependsOn?: string[];
}

export interface GraphBatchRequest {
  requests: GraphBatchSubRequest[];
}

export interface GraphBatchSubResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface GraphBatchResponse {
  responses: GraphBatchSubResponse[];
}

export interface GraphError {
  error: {
    code: string;
    message: string;
    innerError?: { date?: string; "request-id"?: string; "client-request-id"?: string };
  };
}
