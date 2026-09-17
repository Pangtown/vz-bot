import { toOpenAIMessages, toGeminiMessages } from '../src/llm/provider.js';

describe('LLM Multi-Provider Tool Calling Formatting', () => {
  test('toOpenAIMessages - formats parallel tool calls into individual tool messages', () => {
    const messages = [
      { role: 'user', content: 'Check cluster health and list vms' },
      {
        role: 'assistant',
        content: {
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'list_vms', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'run_health_check', arguments: '{}' } }
          ]
        }
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', name: 'list_vms', content: [{ id: 'vm-1', name: 'web-prod' }] },
          { type: 'tool_result', tool_use_id: 'call_2', name: 'run_health_check', content: { status: 'healthy' } }
        ]
      }
    ];

    const formatted = toOpenAIMessages(messages);

    // Should have system prompt, user prompt, assistant tool calls, and TWO separate tool role messages
    expect(formatted.length).toBe(5);
    expect(formatted[0].role).toBe('system');
    expect(formatted[1].role).toBe('user');
    expect(formatted[2].role).toBe('assistant');
    expect(formatted[2].tool_calls.length).toBe(2);

    expect(formatted[3].role).toBe('tool');
    expect(formatted[3].tool_call_id).toBe('call_1');
    expect(formatted[3].content).toBe(JSON.stringify([{ id: 'vm-1', name: 'web-prod' }]));

    expect(formatted[4].role).toBe('tool');
    expect(formatted[4].tool_call_id).toBe('call_2');
    expect(formatted[4].content).toBe(JSON.stringify({ status: 'healthy' }));
  });

  test('toGeminiMessages - formats multi-turn tool outputs as functionResponse parts', () => {
    const messages = [
      { role: 'user', content: 'List VMs' },
      {
        role: 'assistant',
        content: [{ name: 'list_vms', args: { limit: 5 } }]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'list_vms_123', name: 'list_vms', content: '["vm1", "vm2"]' }
        ]
      }
    ];

    const gemini = toGeminiMessages(messages);

    expect(gemini.length).toBe(3);
    expect(gemini[0].role).toBe('user');
    expect(gemini[0].parts[0].text).toBe('List VMs');

    expect(gemini[1].role).toBe('model');
    expect(gemini[1].parts[0].functionCall).toEqual({
      name: 'list_vms',
      args: { limit: 5 }
    });

    expect(gemini[2].role).toBe('user');
    expect(gemini[2].parts[0].functionResponse).toBeDefined();
    expect(gemini[2].parts[0].functionResponse.name).toBe('list_vms');
    expect(gemini[2].parts[0].functionResponse.response.output).toEqual(['vm1', 'vm2']);
  });
});
