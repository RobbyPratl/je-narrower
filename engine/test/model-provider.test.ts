import { afterEach, describe, expect, it, vi } from 'vitest';

const original = {
  provider: process.env.AGENT_PROVIDER,
  baseUrl: process.env.MODEL_BASE_URL,
  apiKey: process.env.MODEL_API_KEY,
  name: process.env.MODEL_NAME,
};

afterEach(() => {
  restore('AGENT_PROVIDER', original.provider);
  restore('MODEL_BASE_URL', original.baseUrl);
  restore('MODEL_API_KEY', original.apiKey);
  restore('MODEL_NAME', original.name);
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('OpenAI-compatible model provider', () => {
  it('uses the configured endpoint, key, and model with JSON mode', async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"findings":[{"text":"Fact.","citations":[{"kind":"entry","ref":"E1"}]}]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { generateFindings } = await import('../src/investigate/provider.js');
    await expect(generateFindings({ entryId: 'E1', toolResults: [] })).resolves.toMatchObject({
      findings: [{ text: 'Fact.' }],
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.groq.test/openai/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    }));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ model: 'qwen/test', response_format: { type: 'json_object' }, stream: false });
  });

  it.each([
    [429, 'model rate limited'],
    [503, 'model provider error'],
  ])('surfaces provider HTTP %s as a contained investigation error', async (status, message) => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('provider unavailable', { status })));
    const { generateFindings } = await import('../src/investigate/provider.js');
    await expect(generateFindings({ entryId: 'E1', toolResults: [] })).rejects.toThrow(message);
  });

  it('rejects invalid structured output explicitly', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'not-json' } }],
    }), { status: 200 })));
    const { generateFindings } = await import('../src/investigate/provider.js');
    await expect(generateFindings({ entryId: 'E1', toolResults: [] })).rejects.toThrow('invalid structured output');
  });
});

function configure() {
  process.env.AGENT_PROVIDER = 'openai-compatible';
  process.env.MODEL_BASE_URL = 'https://api.groq.test/openai/v1';
  process.env.MODEL_API_KEY = 'test-key';
  process.env.MODEL_NAME = 'qwen/test';
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
