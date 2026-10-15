// Google OAuth and Gmail wire types (research mail-providers.md section 8).

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: "Bearer";
  scope: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export interface GoogleOAuthError {
  error: string;
  error_description?: string;
  error_subtype?: string;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessageMetadata {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** Epoch ms as a string. */
  internalDate?: string;
  sizeEstimate?: number;
  payload?: { mimeType?: string; headers?: GmailHeader[] };
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: { message: GmailMessageRef & { labelIds?: string[] } }[];
  messagesDeleted?: { message: GmailMessageRef }[];
  labelsAdded?: { message: GmailMessageRef; labelIds: string[] }[];
  labelsRemoved?: { message: GmailMessageRef; labelIds: string[] }[];
}

export interface GmailHistoryResponse {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId: string;
}

export interface GmailSendAsList {
  sendAs?: { sendAsEmail: string; isPrimary?: boolean }[];
}

export interface GmailBatchModifyRequest {
  ids: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface GoogleApiError {
  error: {
    code: number;
    message: string;
    status?: string;
    errors?: {
      domain?: string;
      reason?: string;
      message?: string;
      location?: string;
      locationType?: string;
    }[];
  };
}
