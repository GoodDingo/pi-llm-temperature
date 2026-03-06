const originalFetch = globalThis.fetch;
globalThis.fetch = async function (...args) {
    const url = args[0] || '';
    if (url.toString().includes('googleapis')) {
        console.log('\n=== REAL OUTGOING NETWORK REQUEST ===');
        console.log('URL:', url.toString());
        if (args[1] && args[1].body) {
            console.log('PAYLOAD:', JSON.stringify(JSON.parse(args[1].body.toString()), null, 2));
        }
    }
    return originalFetch.apply(this, args);
};
