const fetch = require('node-fetch');

exports.handler = async function (event, context) {
    // Securely get API keys from Netlify's environment variables
    const CLIENT_ID = process.env.DHAN_CLIENT_ID;
    const ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN;
    const BASE_URL = "https://api.dhan.co/v2";

    const headers = {
        'Content-Type': 'application/json',
        'access-token': ACCESS_TOKEN,
        'client-id': CLIENT_ID,
        'Accept': 'application/json'
    };

    try {
        // Step 1: Fetch Expiry Dates
        const expiryPayload = { "UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I" };
        const expiryResponse = await fetch(`${BASE_URL}/optionchain/expirylist`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(expiryPayload)
        });
        const expiryData = await expiryResponse.json();
        if (expiryData.status !== 'success' || !expiryData.data?.length) {
            throw new Error(`Failed to fetch expiry dates: ${JSON.stringify(expiryData)}`);
        }
        const nearestExpiry = expiryData.data[0];

        // Step 2: Fetch Option Chain
        const ocPayload = { "UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I", "Expiry": nearestExpiry };
        const ocResponse = await fetch(`${BASE_URL}/optionchain`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(ocPayload)
        });
        const ocData = await ocResponse.json();
        if (ocData.status !== 'success' || !ocData.data?.oc) {
            throw new Error(`Failed to fetch option chain: ${JSON.stringify(ocData)}`);
        }

        // Return the successful data to the frontend
        return {
            statusCode: 200,
            body: JSON.stringify({
                oc_data: ocData.data,
                spot_price: ocData.data.last_price
            }),
        };

    } catch (error) {
        console.error("Function Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};
