import type { TrustLevel } from '../db/schema';
import { coreIntegration, httpIntegration, webhookIntegration } from './core';
import { gmailIntegration, googleCalendarIntegration } from './google';
import { haravanIntegration } from './haravan';
import { kiotvietIntegration } from './kiotviet';
import { misaIntegration, shopeeIntegration, tiktokShopIntegration } from './marketplaces';
import { shopifyIntegration } from './shopify';
import { teamIntegration } from './team';
import { telegramIntegration } from './telegram';
import {
  defaultTrust,
  type IntegrationSpec,
  jsonSchemaOf,
  requiresCredentials,
  type ToolSpec,
} from './types';
import { zaloIntegration } from './zalo';

export * from './types';

export const INTEGRATIONS: IntegrationSpec[] = [
  coreIntegration,
  teamIntegration,
  httpIntegration,
  webhookIntegration,
  zaloIntegration,
  telegramIntegration,
  kiotvietIntegration,
  haravanIntegration,
  shopifyIntegration,
  shopeeIntegration,
  tiktokShopIntegration,
  misaIntegration,
  googleCalendarIntegration,
  gmailIntegration,
];

export class IntegrationCatalog {
  private readonly byId = new Map<string, IntegrationSpec>();
  private readonly byTool = new Map<string, { integration: IntegrationSpec; tool: ToolSpec }>();

  constructor(readonly integrations: IntegrationSpec[] = INTEGRATIONS) {
    for (const integration of integrations) {
      if (this.byId.has(integration.id)) throw new Error(`Duplicate integration ${integration.id}`);
      this.byId.set(integration.id, integration);
      for (const tool of integration.tools) {
        if (this.byTool.has(tool.name)) throw new Error(`Tool ${tool.name} defined twice`);
        this.byTool.set(tool.name, { integration, tool });
      }
    }
  }

  get(id: string): IntegrationSpec | undefined {
    return this.byId.get(id);
  }

  findTool(name: string): { integration: IntegrationSpec; tool: ToolSpec } | undefined {
    return this.byTool.get(name);
  }

  /** Public description for `GET /v1/integrations` (no secrets, JSON schemas for forms and tools). */
  describe(integration: IntegrationSpec) {
    return {
      id: integration.id,
      name: integration.name,
      category: integration.category,
      description: integration.description,
      verified: integration.verified,
      status: integration.status,
      docsUrl: integration.docsUrl ?? null,
      alwaysEnabled: Boolean(integration.alwaysEnabled),
      channel: integration.channel ?? null,
      requiresCredentials: requiresCredentials(integration),
      authFields: jsonSchemaOf(integration.authSchema),
      configFields: integration.configSchema ? jsonSchemaOf(integration.configSchema) : null,
      tools: integration.tools.map((t) => ({
        name: t.name,
        description: t.description,
        risk: typeof t.risk === 'string' ? t.risk : 'depends_on_arguments',
        defaultTrust: defaultTrust(integration, t) as TrustLevel,
        parameters: jsonSchemaOf(t.args),
      })),
    };
  }

  list() {
    return this.integrations.map((i) => this.describe(i));
  }
}
