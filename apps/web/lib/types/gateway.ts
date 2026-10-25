/** Response shapes of the gateway API (see apps/gateway/README.md). */

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  json: boolean;
  streaming: boolean;
}

export interface GwModelProvider {
  provider: string;
  context_length: number;
  max_output_tokens?: number;
  pricing: { prompt: number; completion: number };
  capabilities: Capabilities;
  enabled: boolean;
  verified: boolean;
}

export interface GwModel {
  id: string;
  object: 'model';
  name: string;
  type: 'chat' | 'embedding';
  owned_by: string;
  description?: string;
  context_length?: number | null;
  pricing: { prompt: number; completion: number; unit: string } | null;
  capabilities?: Capabilities;
  available: boolean;
  tiers?: string[];
  aliases?: string[];
  providers: GwModelProvider[];
}

export interface GwModelList {
  object: 'list';
  data: GwModel[];
}

export interface GwUsageBucket {
  key: string;
  requests: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_micros: number;
  avg_latency_ms: number | null;
  cost_usd: number;
}

export interface GwUsage {
  object: 'usage';
  from: string;
  to: string;
  group_by: 'day' | 'model' | 'provider' | 'key' | 'product';
  data: GwUsageBucket[];
  totals: {
    requests: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_micros: number;
    cost_usd: number;
  };
}

export type GwStatus = 'success' | 'error' | 'partial' | 'aborted';

export interface GwRequest {
  id: string;
  object: 'generation';
  created_at: string;
  kind: string;
  product: string;
  api_key_id: string | null;
  requested_model: string;
  model: string | null;
  provider: string | null;
  status: GwStatus;
  error: string | null;
  finish_reason: string | null;
  stream: boolean;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; estimated: boolean };
  cost_micros: number;
  cost_usd: number;
  latency_ms: number | null;
  ttft_ms: number | null;
  attempt_count: number;
}

export interface GwAttempt {
  model: string;
  provider: string;
  endpoint: string;
  upstream_model?: string;
  status: 'success' | 'error' | string;
  error_kind?: string;
  http_status?: number;
  error?: string;
  latency_ms?: number;
  ttft_ms?: number;
}

export interface GwRouting {
  requested_model?: string;
  models?: string[];
  sort?: string;
  skipped?: unknown[];
  auto?: { variant?: string; tier?: string; reason?: string } | null;
}

export interface GwGeneration extends GwRequest {
  fallback_count: number;
  attempts: GwAttempt[];
  routing: GwRouting | null;
}

export interface GwRequestList {
  object: 'list';
  data: GwRequest[];
  next_cursor: string | null;
}

export interface GwEndpointHealth {
  endpoint: string;
  model: string;
  provider: string;
  upstream_model: string;
  verified: boolean;
  circuit: 'closed' | 'open' | 'half_open' | string;
  available: boolean;
  degraded: boolean;
  requests: number;
  successes: number;
  failures: number;
  success_rate: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  p50_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  tokens_per_sec: number | null;
  consecutive_failures: number;
  opened_at: string | number | null;
  blocked_until: string | number | null;
  last_error: { at: string | number; kind: string } | null;
  last_success_at: string | number | null;
}

export interface GwProvidersHealth {
  object: 'list';
  data: GwEndpointHealth[];
  providers: { id: string; name: string; kind: string; enabled: boolean; verified: boolean }[];
}

export interface GwHealth {
  status: string;
  service: string;
  mock_fallback: boolean;
  providers_enabled: string[];
}

// ------------------------------------------------------------------ wallet

export interface WalletSummary {
  balanceMicros: number;
  balanceVnd: number;
  vndPerUsd: number;
  avgDailySpendMicros: number;
  avgDailySpendVnd: number;
  /** "Số dư đủ dùng khoảng N ngày" — null when there is no recent spend. */
  forecastDaysLeft: number | null;
  creditsExpire: boolean;
}

export interface Topup {
  id: string;
  status: 'pending' | 'paid' | string;
  amountVnd: number;
  code: string;
  vndPerUsd: number;
  creditMicros: number;
  receivedVnd: number | null;
  creditedMicros: number | null;
  qrImageUrl: string | null;
  /** Receiving account (newer gateways); older ones only encode it in `qrImageUrl`. */
  bank?: { bankId: string; accountNo: string; accountName: string } | null;
  expiresAt: string;
  paidAt: string | null;
  createdAt: string;
}

export interface BillingProfile {
  orgId?: string;
  taxCode?: string | null;
  companyName?: string | null;
  address?: string | null;
  invoiceEmail?: string | null;
  updatedAt?: string;
}
