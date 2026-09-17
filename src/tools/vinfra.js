import { runVinfraCommand } from '../vhi/vinfra.js';

export const vinfraCli = {
    name: 'execute_vinfra_cli',
    description: 'Execute vinfra CLI commands on the VHI cluster to retrieve cluster-level info or specialized node/service details. Provide an array of command arguments, e.g., ["cluster", "list"] or ["node", "list"]. Omit the "vinfra" prefix.',
    inputSchema: {
        type: 'object',
        properties: {
            args: {
                type: 'array',
                items: {
                    type: 'string'
                },
                description: 'Array of strings representing the vinfra command arguments. Omit the "vinfra" prefix and omit format flags (like -f json) as those are handled automatically.'
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
            const first = String(args[0]).trim();
            if (first.startsWith('/') || first === 'reboot' || first === 'sh' || first === 'bash') {
                throw new Error('Raw shell command execution is prohibited. Only vinfra subcommands are allowed.');
            }
            return await runVinfraCommand(args);
        } catch (err) {
            throw new Error(`execute_vinfra_cli failed: ${err.message}`);
        }
    },
};
