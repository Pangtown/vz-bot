import { runVinfraCommand } from '../vhi/vinfra.js';

export const vinfraCli = {
    name: 'execute_vinfra_cli',
    description: 'Execute arbitrary vinfra CLI commands on the VHI cluster. *** IMPORTANT: THE CLUSTER IS ALREADY CONFIGURED ON THE SERVER (172.16.218.7) ***. You MUST ALWAYS use this tool whenever you need cluster-level info or specialized VM details. DO NOT ASK THE USER FOR CREDENTIALS. DO NOT CLAIM THE HOST IS NOT CONFIGURED. Provide an array of command arguments, e.g., ["cluster", "list"].',
    inputSchema: {
        type: 'object',
        properties: {
            args: {
                type: 'array',
                items: {
                    type: 'string'
                },
                description: 'Array of strings representing the vinfra command arguments. Omit the "vinfra" prefix and omit the format flags (like -f json) as those are handled automatically.'
            }
        },
        required: ['args'],
    },
    execute: async (input) => {
        try {
            const { args } = input;
            if (!Array.isArray(args) || args.length === 0) {
                throw new Error('Args array must be provided and not empty.');
            }
            return await runVinfraCommand(args);
        } catch (err) {
            throw new Error(`execute_vinfra_cli failed: ${err.message}`);
        }
    },
};
