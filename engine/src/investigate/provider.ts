import { agentConfig, type AgentProvider } from '../config.js';
import { AgentOutputSchema } from './case-file.js';
import type { Citation } from './case-file.js';

export interface GenerateInput {
  entryId: string;
  toolResults: Array<{ tool: string; data: unknown }>;
  allowedCitations?: Citation[];
  verifierFailures?: string[];
}

export interface GenerateOutput {
  findings: Array<{ text: string; citations: Citation[] }>;
  raw?: string;
}

export function buildAgentPrompt(input: GenerateInput): { system: string; user: string } {
  const system = `You are an audit investigation assistant. State ONLY facts supported by the tool results.
Write findings only about the target entry identified by entryId. Context rows may support comparisons, but do not report standalone facts about context entries.
Return at most 6 findings. Each finding is one factual sentence and MUST copy one or more citation objects exactly from allowedCitations.
Do NOT conclude fraud, intent, or appropriateness. Return JSON only: {"findings":[{"text":"...","citations":[{"kind":"line"|"entry","ref":"..."}]}]}.
Example: for entryId "E1" and tool data containing {"entry_id":"E1","line_count":2}, a valid response is {"findings":[{"text":"Entry E1 contains 2 lines.","citations":[{"kind":"entry","ref":"E1"}]}]}.
Never invent or transform a citation ref.`;

  return {
    system,
    user: JSON.stringify({
      entryId: input.entryId,
      allowedCitations: input.allowedCitations ?? [{ kind: 'entry', ref: input.entryId }],
      toolResults: input.toolResults,
      verifierFailures: input.verifierFailures ?? [],
    }),
  };
}

export async function generateFindings(input: GenerateInput): Promise<GenerateOutput> {
  const provider = agentConfig.provider;
  if (provider === 'mock') return mockFindings(input);
  if (provider === 'ollama') return ollamaFindings(input);
  if (provider === 'openai-compatible') return openAiCompatibleFindings(input);
  if (provider === 'anthropic') return anthropicFindings(input);
  throw new Error(`unknown agent provider: ${provider}`);
}

function mockFindings(input: GenerateInput): GenerateOutput {
  const findings: GenerateOutput['findings'] = [];
  for (const tr of input.toolResults) {
    if (tr.tool === 'get_entry_lines') {
      const data = tr.data as { entry?: { entry_id: string; narration?: string }; lines?: Array<{ line_id: string; account: string }> };
      if (data.entry) {
        findings.push({
          text: `Entry ${data.entry.entry_id} has ${data.lines?.length ?? 0} lines${data.entry.narration ? ` with narration "${data.entry.narration}"` : ''}.`,
          citations: [{ kind: 'entry', ref: data.entry.entry_id }],
        });
      }
      const firstLine = data.lines?.[0];
      if (firstLine) {
        findings.push({
          text: `First line posts to account ${firstLine.account}.`,
          citations: [{ kind: 'line', ref: firstLine.line_id }],
        });
      }
    }
    if (tr.tool === 'get_pair_diff') {
      const data = tr.data as { status?: string; p1_count?: number; p2_count?: number } | null;
      if (data?.status) {
        findings.push({
          text: `Account pair status across periods is ${data.status} (P1 count ${data.p1_count ?? 0}, P2 count ${data.p2_count ?? 0}).`,
          citations: [{ kind: 'entry', ref: input.entryId }],
        });
      }
    }
  }
  if (findings.length === 0) {
    findings.push({
      text: `Investigation retrieved source data for entry ${input.entryId}.`,
      citations: [{ kind: 'entry', ref: input.entryId }],
    });
  }
  return { findings };
}

async function ollamaFindings(input: GenerateInput): Promise<GenerateOutput> {
  const prompt = buildAgentPrompt(input);

  const res = await fetch(`${agentConfig.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: agentConfig.model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`ollama error: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { message?: { content?: string } };
  const raw = body.message?.content ?? '{}';
  const parsed = AgentOutputSchema.parse(JSON.parse(raw));
  return { findings: parsed.findings, raw };
}

async function anthropicFindings(_input: GenerateInput): Promise<GenerateOutput> {
  throw new Error('anthropic provider not implemented — set AGENT_PROVIDER=ollama or mock');
}

async function openAiCompatibleFindings(input: GenerateInput): Promise<GenerateOutput> {
  if (!agentConfig.modelBaseUrl || !agentConfig.modelApiKey) {
    throw new Error('MODEL_BASE_URL and MODEL_API_KEY are required for openai-compatible provider');
  }
  const prompt = buildAgentPrompt(input);
  let res: Response;
  try {
    res = await fetch(`${agentConfig.modelBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentConfig.modelApiKey}`,
      },
      signal: AbortSignal.timeout(agentConfig.modelTimeoutMs),
      body: JSON.stringify({
        model: agentConfig.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        response_format: { type: 'json_object' },
        stream: false,
      }),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`model request timed out after ${agentConfig.modelTimeoutMs}ms`);
    }
    throw error;
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    if (res.status === 429) throw new Error(`model rate limited (429): ${detail}`);
    throw new Error(`model provider error: ${res.status} ${detail}`);
  }

  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error('model provider returned no message content');
  try {
    const parsed = AgentOutputSchema.parse(JSON.parse(raw));
    return { findings: parsed.findings, raw };
  } catch (error) {
    throw new Error(`model provider returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`);
  }
}
