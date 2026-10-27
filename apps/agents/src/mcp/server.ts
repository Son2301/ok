import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentRow } from '../db/schema';
import { toolMessageContent } from '../runtime/loop';
import type { ToolService } from '../services/tools';

export const MCP_SERVER_INFO = { name: 'minh-agents', version: '1.0.0' } as const;

/**
 * The agent's tools as an MCP server (Streamable HTTP, stateless, JSON
 * responses). Third-party runtimes (OpenClaw, Hermes, any MCP client) connect
 * to `/mcp/:agentId` with the agent's runtime token. Tools execute in the
 * control plane exactly like the builtin runtime's, with the same trust levels
 * (approval queue) and traces — credentials never leave the control plane.
 */
export async function handleMcpRequest(
  req: Request,
  agent: AgentRow,
  tools: ToolService,
  opts: { conversationId?: string | null } = {},
): Promise<Response> {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: `Tools of the AI employee "${agent.name}" (${agent.role}). Actions that need owner approval return status "pending_approval".`,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const resolved = await tools.resolve(agent);
    return {
      tools: resolved.map((r) => ({
        name: r.tool.name,
        description: r.definition.function.description,
        inputSchema: (r.definition.function.parameters ?? { type: 'object', properties: {} }) as {
          type: 'object';
          properties?: Record<string, object>;
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const outcome = await tools.execute(agent, request.params.name, request.params.arguments ?? {}, {
      source: 'mcp',
      conversationId: opts.conversationId ?? null,
    });
    return { content: [{ type: 'text' as const, text: toolMessageContent(outcome) }], isError: !outcome.ok };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close().catch(() => undefined);
  }
}
