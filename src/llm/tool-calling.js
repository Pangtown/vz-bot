/**
 * Tool definitions for LLM (OpenAI/Claude style) and parsing of tool calls from response
 */

export function getToolDefinitions() {
  return [
    {
      name: 'list_vms',
      description: 'List virtual machines in VHI. Optionally filter by status (e.g. ACTIVE, SHUTOFF, ERROR).',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by VM status' },
          limit: { type: 'number', description: 'Max number to return', default: 50 },
        },
      },
    },
    {
      name: 'get_vm',
      description: 'Get details of a single VM by ID.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'Server/VM ID' },
        },
        required: ['server_id'],
      },
    },
    {
      name: 'reboot_vm',
      description: 'Reboot a VM. Use SOFT for graceful, HARD for power cycle.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'Server/VM ID' },
          type: { type: 'string', enum: ['SOFT', 'HARD'], default: 'SOFT' },
        },
        required: ['server_id'],
      },
    },
    {
      name: 'start_vm',
      description: 'Start a stopped VM.',
      input_schema: {
        type: 'object',
        properties: { server_id: { type: 'string' } },
        required: ['server_id'],
      },
    },
    {
      name: 'stop_vm',
      description: 'Stop a running VM.',
      input_schema: {
        type: 'object',
        properties: { server_id: { type: 'string' } },
        required: ['server_id'],
      },
    },
    {
      name: 'run_health_check',
      description: 'Run infrastructure health check: list VMs and their status, optionally compare to thresholds.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_volumes',
      description: 'List block storage volumes in VHI.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_networks',
      description: 'List networks in VHI.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'create_vm',
      description: 'Create a new VM in VHI.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the VM' },
          imageRef: { type: 'string', description: 'Image ID to use' },
          flavorRef: { type: 'string', description: 'Flavor/Size ID to use' },
          networks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { uuid: { type: 'string' } }
            },
            description: 'List of networks to connect to (optional)'
          }
        },
        required: ['name', 'imageRef', 'flavorRef'],
      },
    },
    {
      name: 'create_volume',
      description: 'Create a block storage volume in VHI.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the volume' },
          size: { type: 'number', description: 'Size of the volume in GB' }
        },
        required: ['name', 'size']
      }
    },
    {
      name: 'create_network',
      description: 'Create a new network in VHI.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the network' },
          admin_state_up: { type: 'boolean', description: 'Whether admin state is up', default: true }
        },
        required: ['name']
      }
    }
  ];
}

/**
 * Convert to Claude tool format
 */
export function toClaudeTools() {
  return getToolDefinitions().map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Parse tool_use blocks from Claude message; returns { name, id, args }
 */
export function parseClaudeToolUse(message) {
  const uses = [];
  if (message.content && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name && block.id) {
        uses.push({
          id: block.id,
          name: block.name,
          args: block.input || {},
        });
      }
    }
  }
  return uses;
}
/**
 * Convert to Gemini tool format
 */
export function toGeminiTools() {
  return [{
    functionDeclarations: getToolDefinitions().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }))
  }];
}

/**
 * Parse functionCalls from Gemini
 */
export function parseGeminiToolUse(message) {
  const uses = [];
  if (message.functionCalls && message.functionCalls.length > 0) {
    for (const call of message.functionCalls) {
      uses.push({
        id: call.id || call.name + '_' + Math.random().toString(36).slice(2),
        name: call.name,
        args: call.args || {},
      });
    }
  }
  return uses;
}

/**
 * Convert to OpenAI tool format
 */
export function toOpenAITools() {
  return getToolDefinitions().map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.input_schema?.properties || {},
        required: t.input_schema?.required || []
      }
    }
  }));
}

/**
 * Parse tool_calls from OpenAI response message
 */
export function parseOpenAIToolUse(message) {
  const uses = [];
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const call of message.tool_calls) {
      if (call.type === 'function') {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch (e) { }
        uses.push({
          id: call.id,
          name: call.function.name,
          args: args
        });
      }
    }
  }
  return uses;
}
