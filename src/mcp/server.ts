import * as readline from 'node:readline';

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The tool's answer as text; a thrown error is reported to the agent as a failed call. */
  call(args: Record<string, unknown>): Promise<string>;
}

export interface ServerInfo {
  name: string;
  version: string;
  /** Read by the client into the agent's instructions (Claude Code adds them to its prompt). */
  instructions: string;
}

/** Protocol versions this server can speak; it answers with the client's when it knows it. */
const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A Model Context Protocol server over stdio (one JSON-RPC message per line) that offers
 * tools only: all Claude Code needs to list and call them, without the SDK's start-up cost.
 * Resolves when the input ends.
 */
export function serve(
  info: ServerInfo,
  tools: Tool[],
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const send = (message: object) => output.write(JSON.stringify(message) + '\n');

  const handle = async (req: Request): Promise<unknown> => {
    const params = req.params ?? {};
    switch (req.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return {
          protocolVersion:
            typeof asked === 'string' && VERSIONS.includes(asked) ? asked : VERSIONS.at(-1),
          capabilities: { tools: {} },
          serverInfo: { name: info.name, version: info.version },
          instructions: info.instructions,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        };
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          return { content: [{ type: 'text', text: await tool.call(args) }] };
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${req.method}`);
    }
  };

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<unknown>>();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // Notifications (initialized, cancelled) need no answer.
    if (req.id === undefined || req.id === null) return;
    const id = req.id;
    const done = handle(req).then(
      (result) => void send({ jsonrpc: '2.0', id, result }),
      (e: unknown) =>
        void send({
          jsonrpc: '2.0',
          id,
          error:
            e instanceof RpcError
              ? { code: e.code, message: e.message }
              : { code: -32603, message: String(e) },
        }),
    );
    const tracked = done.finally(() => pending.delete(tracked));
    pending.add(tracked);
  });
  return new Promise((resolve) =>
    lines.on('close', () => void Promise.all(pending).then(() => resolve())),
  );
}
