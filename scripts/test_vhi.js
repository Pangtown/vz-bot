import 'dotenv/config';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { getToken } from '../src/vhi/identity.js';

async function test() {
    try {
        const res = await getToken();
        console.log("Success!", res);
    } catch (err) {
        console.error("Error:", err.message);
    }
}

test();
