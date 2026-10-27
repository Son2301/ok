import type { Core } from '@minh/core';
import type { DbHandle } from '@minh/db';
import { createLogger, type Logger } from '@minh/shared';
import type { AgentsConfig } from './config';
import { IntegrationCatalog, type ToolServices } from './integrations';
import { BackgroundTasks } from './lib/async';
import type { SecretBox } from './lib/crypto';
import type { FetchLike } from './lib/http';
import { type SafeFetchOptions, type SafeResponse, safeFetch } from './lib/ssrf';
import { type Clock, systemClock } from './lib/time';
import { InlineDriver } from './runtime/drivers/inline';
import type { RuntimeDriver } from './runtime/drivers/types';
import { runAgentLoop } from './runtime/loop';
import { Scheduler } from './scheduler';
import { AgentService } from './services/agents';
import { ApprovalService } from './services/approvals';
import { BillingService } from './services/billing';
import { ChannelService } from './services/channels';
import { CompanyService, ContextBuilder } from './services/context';
import { ConversationService } from './services/conversations';
import { CredentialStore } from './services/credentials';
import { EventLog } from './services/events';
import { KnowledgeService } from './services/knowledge';
import { TaskService } from './services/tasks';
import { RuntimeTokenService } from './services/tokens';
import { ToolService } from './services/tools';
import { LlmBroker, type LlmFactory, UsageService } from './services/usage';

export interface PlatformDeps {
  handle: DbHandle;
  core: Core;
  config: AgentsConfig;
  /** Gateway client factory (tests pass one returning MockLlm). */
  llm: LlmFactory;
  box: SecretBox;
  /** Defaults to the inline driver. */
  driver?: RuntimeDriver;
  clock?: Clock;
  /** Used by integrations and channel replies (tests pass a fixture-based fake). */
  fetch?: FetchLike;
  /** SSRF-safe fetch for http_request/send_webhook (overridable for tests). */
  safeFetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeResponse>;
  logger?: Logger;
  catalog?: IntegrationCatalog;
}

export type Platform = ReturnType<typeof createPlatform>;

/** Wire every service of the control plane. Pure: no I/O until methods are called. */
export function createPlatform(deps: PlatformDeps) {
  const { handle, core, config } = deps;
  const db = handle.db;
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createLogger('agents');
  const fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  const catalog = deps.catalog ?? new IntegrationCatalog();
  const driver = deps.driver ?? new InlineDriver(clock);
  const bg = new BackgroundTasks((err) =>
    logger.error('background_task_failed', { err: (err as Error).message }),
  );

  const events = new EventLog(db, clock);
  const tokens = new RuntimeTokenService(db, clock);
  const credentials = new CredentialStore(db, deps.box, clock);
  const knowledge = new KnowledgeService(handle, clock);
  const tasks = new TaskService(db, clock);
  const company = new CompanyService(db, clock, config.timezone);
  const context = new ContextBuilder(db, tasks, company, clock);
  const usage = new UsageService(db, clock, config.timezone);
  const broker = new LlmBroker(db, usage, deps.llm, config, events);
  const billing = new BillingService(db, core, config, clock);
  const toolServices: ToolServices = {
    knowledge: { search: (input) => knowledge.search(input) },
    tasks,
    safeFetch: deps.safeFetch ?? safeFetch,
  };
  const tools = new ToolService({
    db,
    catalog,
    credentials,
    services: toolServices,
    fetch: fetchFn,
    clock,
    timezone: config.timezone,
    logger,
  });
  const approvals = new ApprovalService(db, tools, events, clock);
  const conversations = new ConversationService({
    db,
    driver,
    tools,
    context,
    company,
    tokens,
    events,
    config,
    clock,
    logger,
  });
  const agents = new AgentService({
    db,
    driver,
    tokens,
    billing,
    usage,
    broker,
    events,
    catalog,
    credentials,
    tools,
    config,
    clock,
    bg,
    logger,
  });
  const channels = new ChannelService({
    db,
    agents,
    conversations,
    credentials,
    catalog,
    events,
    config,
    fetch: fetchFn,
    clock,
    bg,
    logger,
  });
  const scheduler = new Scheduler({
    handle,
    agents,
    billing,
    conversations,
    tasks,
    company,
    events,
    config,
    clock,
    logger,
  });

  broker.hooks.onBudgetExhausted = async (agent, spent) => {
    await agents.pauseForBudget(agent, spent);
  };

  if (driver instanceof InlineDriver) {
    driver.setExecutor(async (target, req, opts) => {
      const agent = await agents.getById(target.agentId);
      if (!agent) throw new Error('Agent not found');
      return runAgentLoop({
        llm: broker.clientFor(agent.id, req.conversationId),
        request: req,
        tools: {
          execute: (call, signal) =>
            tools.execute(agent, call.name, call.arguments, {
              conversationId: req.conversationId,
              toolCallId: call.id,
              source: 'inline',
              signal,
            }),
        },
        onEvent: opts.onEvent,
        stream: Boolean(opts.onEvent),
        signal: opts.signal,
      });
    });
  }

  return {
    config,
    handle,
    core,
    clock,
    logger,
    bg,
    catalog,
    driver,
    events,
    tokens,
    credentials,
    knowledge,
    tasks,
    company,
    context,
    usage,
    broker,
    billing,
    tools,
    approvals,
    conversations,
    agents,
    channels,
    scheduler,
  };
}
