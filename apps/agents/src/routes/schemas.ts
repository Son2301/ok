import { z } from 'zod';
import { PLAN_IDS, RUNTIME_IDS } from '../config';
import { TRUST_LEVELS } from '../integrations/types';
import { isValidTimeZone } from '../lib/time';

const trust = z.enum(TRUST_LEVELS);

export const integrationSettingSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Per-tool trust level: off | draft | approve | auto. */
  tools: z.record(z.string(), trust).optional(),
});

export const settingsSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(20).optional(),
    temperature: z.number().min(0).max(2).optional(),
    language: z.enum(['vi', 'en']).optional(),
    timezone: z.string().refine(isValidTimeZone, 'unknown time zone').optional(),
    inbound: z
      .object({
        policy: z.enum(['open', 'allowlist']),
        allowlist: z.array(z.string().min(1).max(200)).max(1000).default([]),
      })
      .optional(),
    aiDisclosure: z.object({ enabled: z.boolean(), text: z.string().max(500).optional() }).optional(),
  })
  .strict();

const agentFields = {
  name: z.string().trim().min(1).max(80),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
  role: z.string().trim().min(1).max(120).optional(),
  jobDescription: z.string().max(20_000).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  runtime: z.enum(RUNTIME_IDS).optional(),
  plan: z.enum(PLAN_IDS).optional(),
  integrations: z.record(z.string(), integrationSettingSchema).optional(),
  settings: settingsSchema.optional(),
  reportsTo: z.string().nullable().optional(),
  /** Monthly cap (micro-USD) on LLM usage billed to the customer; null = no cap. */
  budgetMonthlyMicros: z.number().int().min(0).nullable().optional(),
};

export const createAgentSchema = z.object(agentFields).strict();
export const updateAgentSchema = z.object({ ...agentFields, name: agentFields.name.optional() }).strict();

export const putIntegrationSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
    tools: z.record(z.string(), trust).optional(),
  })
  .strict();

export const messageSchema = z.object({
  message: z.string().min(1).max(8000),
  /** Your end-user id; one conversation per (agent, channel, userId). */
  userId: z.string().min(1).max(200).default('api'),
});

export const knowledgeJsonSchema = z.object({
  title: z.string().max(200).optional(),
  filename: z.string().max(255).optional(),
  mimeType: z.string().max(100).optional(),
  content: z.string().min(1).max(2_000_000),
});

export const channelSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Telegram: call setWebhook with our URL and a fresh secret token. */
  registerWebhook: z.boolean().optional(),
});

export const runtimeTokenSchema = z.object({ label: z.string().max(100).optional() });

const taskStatus = z.enum(['todo', 'in_progress', 'blocked', 'done']);
const taskPriority = z.enum(['low', 'medium', 'high', 'urgent']);

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).optional(),
    assigneeAgentId: z.string().nullable().optional(),
    status: taskStatus.optional(),
    priority: taskPriority.optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    parentTaskId: z.string().nullable().optional(),
  })
  .strict();
export const updateTaskSchema = createTaskSchema.partial().strict();
export const commentSchema = z.object({ body: z.string().trim().min(1).max(10_000) });

export const decisionSchema = z.object({ note: z.string().max(1000).optional() });

export const companySchema = z
  .object({
    companyName: z.string().max(200).nullable().optional(),
    companyDescription: z.string().max(5000).nullable().optional(),
    language: z.enum(['vi', 'en']).optional(),
    timezone: z.string().refine(isValidTimeZone, 'unknown time zone').optional(),
  })
  .strict();

export const publicChatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'sessionId must be 8-64 URL-safe characters'),
});

export const toolProxySchema = z.object({
  arguments: z.unknown().optional(),
  conversationId: z.string().max(100).optional(),
  toolCallId: z.string().max(200).optional(),
});

export const chatCompletionSchema = z
  .object({
    model: z.string().optional(),
    messages: z
      .array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']) }).passthrough())
      .min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough();
