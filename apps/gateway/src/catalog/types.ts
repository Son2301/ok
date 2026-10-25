/** Model tiers used by the `auto` smart router. */
export type Tier = 'fast' | 'balanced' | 'frontier' | 'reasoning';
export const TIERS: readonly Tier[] = ['fast', 'balanced', 'frontier', 'reasoning'];

/** Things a model is notably good at; the auto router prefers matching models. */
export type Strength = 'code' | 'math' | 'multilingual' | 'vision' | 'long_context' | 'tools';

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  json: boolean;
  streaming: boolean;
}

/** USD per 1M tokens. */
export interface PricePer1M {
  input: number;
  output: number;
}

/** Per-endpoint upstream quirks the adapters apply before sending a request. */
export interface EndpointQuirks {
  /** Top-level request params this upstream rejects; they are stripped (e.g. `temperature` on newer Claude models). */
  dropParams?: string[];
  /** Upstream rejects forced tool use; `tool_choice: 'required' | {function}` is downgraded to `'auto'`. */
  noForcedToolChoice?: boolean;
}

export interface CatalogEndpoint {
  /** Provider id, e.g. `openai`, `azure`, `anthropic`, `groq`. Must exist in the provider registry. */
  provider: string;
  /** Model name sent upstream (Azure: deployment name). */
  upstreamModel: string;
  /** What we charge the customer, USD per 1M tokens. */
  price: PricePer1M;
  /** What the upstream charges us, USD per 1M tokens. Never exposed to customers. */
  cost: PricePer1M;
  contextLength: number;
  maxOutputTokens?: number;
  capabilities: Capabilities;
  quirks?: EndpointQuirks;
  /** `true` only once this endpoint was exercised against the live provider API. */
  verified?: boolean;
}

export interface AutoProfile {
  tiers: Tier[];
  /** Relative quality score, 0–100, used to rank models inside a tier. */
  quality: number;
  strengths?: Strength[];
}

export interface CatalogModel {
  /** Public id, `<vendor>/<model>`, e.g. `openai/gpt-4o-mini`. */
  id: string;
  name: string;
  type: 'chat' | 'embedding';
  description?: string;
  aliases?: string[];
  auto?: AutoProfile;
  endpoints: CatalogEndpoint[];
}

/** An endpoint after the catalog was resolved against configured provider credentials. */
export interface Endpoint extends CatalogEndpoint {
  /** Stable id `<modelId>@<provider>`; health is tracked per endpoint id. */
  id: string;
  modelId: string;
  enabled: boolean;
}

export interface Model extends Omit<CatalogModel, 'endpoints'> {
  endpoints: Endpoint[];
}
