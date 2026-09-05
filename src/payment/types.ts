export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/** x402 V2 payment requirements advertised to HTTP clients (CAIP-2 network). */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** Live B402 facilitator verify/settle body (translated at the edge). */
export interface B402FacilitatorAuthorization {
  token: string;
  from: string;
  to: string;
  value: string;
  validAfter: number | string;
  validBefore: number | string;
  nonce: string;
}

export interface B402FacilitatorPaymentPayload {
  token: string;
  payload: {
    signature: string;
    authorization: B402FacilitatorAuthorization;
  };
}

export interface B402FacilitatorRequirements {
  network: string;
  relayerContract: string;
}

export interface B402FacilitatorRequest {
  paymentPayload: B402FacilitatorPaymentPayload;
  paymentRequirements: B402FacilitatorRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  extensionResponses?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  transaction: string;
  network: string;
  amount?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  extensionResponses?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface TokenConfig {
  address: string;
  symbol: string;
  decimals: number;
  /** EIP-712 domain name — B402 Relayer domain uses "B402". */
  eip712Name: string;
  eip712Version: string;
  /** Transfer method advertised to clients (b402-relayer, not native EIP-3009). */
  assetTransferMethod: string;
}

/** B402 Relayer TransferWithAuthorization (includes token in typed data). */
export interface TransferWithAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  token?: string;
}

export interface TransferWithAuthorizationPayload {
  signature: string;
  authorization: TransferWithAuthorization;
}

/** @deprecated Use TransferWithAuthorization — kept for transitional aliases. */
export type Eip3009Authorization = TransferWithAuthorization;
/** @deprecated Use TransferWithAuthorizationPayload */
export type Eip3009Payload = TransferWithAuthorizationPayload;

export function isTransferWithAuthorizationPayload(payload: unknown): payload is TransferWithAuthorizationPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  const auth = obj.authorization;
  if (typeof auth !== "object" || auth === null) return false;
  const a = auth as Record<string, unknown>;
  return (
    typeof obj.signature === "string" &&
    typeof a.from === "string" &&
    typeof a.to === "string" &&
    typeof a.value === "string" &&
    typeof a.validAfter === "string" &&
    typeof a.validBefore === "string" &&
    typeof a.nonce === "string"
  );
}

/** @deprecated Use isTransferWithAuthorizationPayload */
export const isEip3009Payload = isTransferWithAuthorizationPayload;

export function mapCaip2NetworkToB402(network: string): string {
  const n = network.trim().toLowerCase();
  if (n === "eip155:56" || n === "bsc" || n === "bnb") return "bsc";
  if (n === "eip155:8453" || n === "base") return "base";
  return n;
}

export function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}
