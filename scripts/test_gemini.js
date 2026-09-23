import 'dotenv/config';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { chat } from '../src/llm/provider.js';

async function test() {
    try {
        const messages = [{ role: 'user', content: 'List all VMs' }];
        const res = await chat(messages, { provider: 'gemini' });
        console.log("Response:", JSON.stringify(res, null, 2));

        // If it wants to call a tool, let's emulate what conversation.js does
        if (res.toolCalls && res.toolCalls.length > 0) {
            const call = res.toolCalls[0];
            console.log("LLM wants to call:", call.name);
            const tools = await import('../src/tools/registry.js');
            try {
                const result = await tools.run(call.name, call.args);
                console.log("Tool result:", result);
            } catch (err) {
                console.error("Tool ERROR:", err.message);
            }
        }
    } catch (err) {
        console.error("Chat error:", err);
    }
}

test();
