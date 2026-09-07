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
      description: 'Get details of a single VM by Name or ID.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'Server/VM Name or ID' },
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
          server_id: { type: 'string', description: 'Server/VM Name or ID' },
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
        properties: { server_id: { type: 'string', description: 'Server/VM Name or ID' } },
        required: ['server_id'],
      },
    },
    {
      name: 'stop_vm',
      description: 'Stop a running VM.',
      input_schema: {
        type: 'object',
        properties: { server_id: { type: 'string', description: 'Server/VM Name or ID' } },
        required: ['server_id'],
      },
    },
    {
      name: 'run_health_check',
      description: 'Run infrastructure health check: list VMs and their status, optionally compare to thresholds.',
      input_schema: { type: 'object', properties: { verbose: { type: 'boolean', description: 'Enable verbose output' } } },
    },
    {
      name: 'list_images',
      description: 'List images (OS templates) in VHI.',
      input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Max items' } } },
    },
    {
      name: 'get_image',
      description: 'Get details of a single image by Name or ID.',
      input_schema: {
        type: 'object',
        properties: {
          image_id: { type: 'string', description: 'Image Name or ID' },
        },
        required: ['image_id'],
      },
    },
    {
      name: 'list_volumes',
      description: 'List block storage volumes in VHI.',
      input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Max items' } } },
    },
    {
      name: 'get_volume',
      description: 'Get details of a single volume by Name or ID.',
      input_schema: {
        type: 'object',
        properties: {
          volume_id: { type: 'string', description: 'Volume Name or ID' },
        },
        required: ['volume_id'],
      },
    },
    {
      name: 'list_volume_types',
      description: 'List block storage volume types (storage policies) in VHI.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_networks',
      description: 'List networks in VHI.',
      input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Max items' } } },
    },
    {
      name: 'list_flavors',
      description: 'List available compute flavors (sizes) in VHI.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'create_vm',
      description: 'Create a new VM in VHI. You can specify names for image, flavor, and networks.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the VM' },
          imageRef: { type: 'string', description: 'Image Name or ID to use' },
          flavorRef: { type: 'string', description: 'Flavor Name or ID to use' },
          volume_size: { type: 'number', description: 'Boot disk size in GB (optional, defaults to 50)' },
          volume_type: { type: 'string', description: 'Storage policy name or ID for the boot disk. THIS IS REQUIRED.' },
          networks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { uuid: { type: 'string', description: 'Network Name or ID' } }
            },
            description: 'List of networks to connect to (optional)'
          }
        },
        required: ['name', 'imageRef', 'flavorRef', 'volume_type'],
      },
    },
    {
      name: 'create_volume',
      description: 'Create a block storage volume in VHI.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the volume' },
          size: { type: 'number', description: 'Size of the volume in GB' },
          volume_type: { type: 'string', description: 'Storage policy name or ID (e.g., "standard")' },
          description: { type: 'string', description: 'Optional volume description' }
        },
        required: ['name', 'size']
      }
    },
    {
      name: 'delete_vm',
      description: 'Delete a VM by Name or ID.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'Server/VM Name or ID' },
        },
        required: ['server_id'],
      },
    },
    {
      name: 'delete_volume',
      description: 'Delete a volume by Name or ID.',
      input_schema: {
        type: 'object',
        properties: {
          volume_id: { type: 'string', description: 'Volume Name or ID' },
        },
        required: ['volume_id'],
      },
    },
    {
      name: 'attach_volume',
      description: 'Attach a volume to a VM.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'Server Name or ID' },
          volume_id: { type: 'string', description: 'Volume Name or ID' },
          device: { type: 'string', description: 'Device name, e.g., /dev/vdb (optional)' }
        },
        required: ['server_id', 'volume_id']
      }
    },
    {
      name: 'create_network',
      description: 'Create a new network in VHI. Optionally include cidr to also create a subnet.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the network' },
          cidr: { type: 'string', description: 'Optional subnet CIDR, e.g. 192.168.10.0/24' },
          admin_state_up: { type: 'boolean', description: 'Whether admin state is up', default: true },
          shared: { type: 'boolean', description: 'Whether the network is shared across projects', default: false },
          external: { type: 'boolean', description: 'Whether this is an external/public network', default: false }
        },
        required: ['name']
      }
    },
    {
      name: 'delete_network',
      description: 'Delete a network by Name or ID.',
      input_schema: {
        type: 'object',
        properties: { network_id: { type: 'string', description: 'Network Name or ID' } },
        required: ['network_id']
      }
    },
    {
      name: 'list_subnets',
      description: 'List subnets, optionally filtered by network.',
      input_schema: {
        type: 'object',
        properties: { network_id: { type: 'string', description: 'Optional network Name or ID' } }
      }
    },
    {
      name: 'create_subnet',
      description: 'Create a subnet on a network.',
      input_schema: {
        type: 'object',
        properties: {
          network_id: { type: 'string', description: 'Network Name or ID' },
          cidr: { type: 'string', description: 'CIDR e.g. 10.0.0.0/24' },
          name: { type: 'string' }
        },
        required: ['network_id', 'cidr']
      }
    },
    {
      name: 'list_scheduled_jobs',
      description: 'List scheduled automation jobs (start/stop/reboot VM or snapshot a volume).',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'create_scheduled_job',
      description: 'Create a scheduled job on the current cluster. Actions: start_vm, stop_vm, reboot_vm, snapshot_volume.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          action: { type: 'string', enum: ['start_vm', 'stop_vm', 'reboot_vm', 'snapshot_volume'] },
          targetId: { type: 'string', description: 'VM or volume Name or ID' },
          target_name: { type: 'string' },
          cron: { type: 'string', description: '5-field cron, e.g. 0 2 * * *' },
          minutes: { type: 'number', description: 'Interval in minutes if not using cron' }
        },
        required: ['name', 'action', 'targetId']
      }
    },
    {
      name: 'execute_vinfra_cli',
      description: 'Execute arbitrary vinfra CLI commands on the VHI cluster. Provide an array of command arguments, e.g., ["cluster", "list"], or ["node", "list"]. This tool is for advanced infrastructure management and viewing details not available via REST. Use this for cluster-wide status or low-level node maintenance.',
      input_schema: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: {
              type: 'string'
            },
            description: 'Array of strings representing the vinfra command arguments. Omit the "vinfra" prefix.'
          }
        },
        required: ['args']
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
