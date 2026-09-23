import { GoogleGenAI } from '@google/genai';
import { toGeminiTools } from '../src/llm/tool-calling.js';
import 'dotenv/config';

async function test() {
    const ai = new GoogleGenAI({ apiKey: process.env.ANTHROPIC_API_KEY }); // we can use a dummy or just check if it fails
    console.log("Mock check of Gemini response structure.");
    try {
        const res = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: "Call the list_vms tool" }] }],
            config: { tools: toGeminiTools() }
        });
        console.log("res.functionCalls:", res.functionCalls);
        console.log("res.candidates[0].content.parts:", JSON.stringify(res.candidates[0].content.parts, null, 2));
    } catch (err) {
        console.error(err.message);
    }
}

test();
