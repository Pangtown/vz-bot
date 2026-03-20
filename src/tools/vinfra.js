import { runVinfraCommand } from '../vhi/vinfra.js';

export const vinfraCli = {
    name: 'execute_vinfra_cli',
    description: 'Execute arbitrary vinfra CLI commands on the VHI cluster. Provide an array of command arguments, e.g., ["cluster", "list"], or ["node", "list"]. This tool is highly capable of full infrastructure viewing and management. Use this tool when standard REST endpoints fall short.',
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
