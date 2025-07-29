const fetch = require('node-fetch');

// Helper functions (indianFormat, getPercentileRanks, etc.) remain the same...
const indianFormat = (num) => {
    if (isNaN(num)) return num;
    return Math.round(num).toLocaleString('en-IN');
};

const getPercentileRanks = (arr) => {
    const sorted = [...arr].map((value, originalIndex) => ({ value, originalIndex }))
        .sort((a, b) => a.value - b.value);
    const ranks = new Array(arr.length);
    sorted.forEach(({ originalIndex }, i) => {
        ranks[originalIndex] = (i + 1) / arr.length;
    });
    return ranks;
};

const calculateMaxPain = (df) => {
    let minLoss = Infinity, maxPainStrike = 0;
    const strikes = df.map(row => row['Strike Price']);
    strikes.forEach(expiryStrike => {
        let totalLoss = 0;
        df.forEach(row => {
            if (row['Strike Price'] > expiryStrike) totalLoss += (row['Strike Price'] - expiryStrike) * row['CE OI'];
            else if (row['Strike Price'] < expiryStrike) totalLoss += (expiryStrike - row['Strike Price']) * row['PE OI'];
        });
        if (totalLoss < minLoss) { minLoss = totalLoss; maxPainStrike = expiryStrike; }
    });
    return maxPainStrike;
};

const calculateSignalConviction = (signalType, analytics, df) => {
    let score = 0;
    const sup = [], con = [];
    const { pcr_oi, total_pe_change, total_ce_change, spot } = analytics;

    const oi_ratio = total_ce_change > 0 ? parseFloat((total_pe_change / total_ce_change).toFixed(2)) : 0;
    const ce_unwind = df.filter(r => r['Strike Price'] <= spot && r['CE Change'] < 0).reduce((sum, r) => sum + r['CE Change'], 0);
    const pe_unwind = df.filter(r => r['Strike Price'] >= spot && r['PE Change'] < 0).reduce((sum, r) => sum + r['PE Change'], 0);

    if (signalType === 'call') {
        if (pcr_oi > 1.1) { sup.push(`PCR > 1.1 (${pcr_oi})`); score++; }
        if (oi_ratio > 1.5) { sup.push(`Strong Put Writing (Ratio: ${oi_ratio})`); score += 2; }
        else if (oi_ratio > 1.0) { sup.push("Put Writing > Call Writing"); score++; }
        if (ce_unwind < -10000) { sup.push(`Call Writers Covering (${indianFormat(Math.abs(ce_unwind))})`); score += 2; }

        if (pcr_oi < 0.8) { con.push(`PCR < 0.8 (${pcr_oi})`); score--; }
        if (oi_ratio > 0 && oi_ratio < 0.8) { con.push("Call Writing > Put Writing"); score--; }
        if (pe_unwind < -10000) { con.push(`Put Writers Covering (${indianFormat(Math.abs(pe_unwind))})`); score -= 2; }
    } else if (signalType === 'put') {
        if (pcr_oi < 0.8) { sup.push(`PCR < 0.8 (${pcr_oi})`); score++; }
        if (oi_ratio > 0 && oi_ratio < 0.7) { sup.push(`Strong Call Writing (Ratio: ${oi_ratio})`); score += 2; }
        else if (oi_ratio > 0 && oi_ratio < 1.0) { sup.push("Call Writing > Put Writing"); score++; }
        if (pe_unwind < -10000) { sup.push(`Put Writers Covering (${indianFormat(Math.abs(pe_unwind))})`); score += 2; }

        if (pcr_oi > 1.1) { con.push(`PCR > 1.1 (${pcr_oi})`); score--; }
        if (oi_ratio > 1.2) { con.push("Put Writing > Call Writing"); score--; }
        if (ce_unwind < -10000) { con.push(`Call Writers Covering (${indianFormat(Math.abs(ce_unwind))})`); score -= 2; }
    }

    const strength = score >= 3 ? "Strong" : score >= 1 ? "Medium" : "Weak / Risky";
    return { score, strength, supporting: sup, contradicting: con };
};

// Function to log data to Google Sheets
async function logToGoogleSheet(data) {
    const sheetUrl = process.env.GOOGLE_SHEET_URL;
    if (!sheetUrl) {
        console.log("Google Sheet URL not configured. Skipping log.");
        return;
    }
    try {
        await fetch(sheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch (error) {
        console.error("Error logging to Google Sheet:", error);
    }
}

exports.handler = async function (event, context) {
    const CLIENT_ID = process.env.DHAN_CLIENT_ID;
    const ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN;
    const BASE_URL = "https://api.dhan.co/v2";

    const headers = {
        'Content-Type': 'application/json', 'access-token': ACCESS_TOKEN,
        'client-id': CLIENT_ID, 'Accept': 'application/json'
    };

    try {
        const expiryPayload = { "UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I" };
        const expiryResponse = await fetch(`${BASE_URL}/optionchain/expirylist`, { method: 'POST', headers, body: JSON.stringify(expiryPayload) });
        const expiryData = await expiryResponse.json();
        if (expiryData.status !== 'success' || !expiryData.data?.length) throw new Error(`Failed to fetch expiry dates: ${JSON.stringify(expiryData)}`);
        const nearestExpiry = expiryData.data[0];

        const ocPayload = { "UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I", "Expiry": nearestExpiry };
        const ocResponse = await fetch(`${BASE_URL}/optionchain`, { method: 'POST', headers, body: JSON.stringify(ocPayload) });
        const ocData = await ocResponse.json();
        if (ocData.status !== 'success' || !ocData.data?.oc) throw new Error(`Failed to fetch option chain: ${JSON.stringify(ocData)}`);

        const spot_price = ocData.data.last_price;
        const firstStrikeKey = Object.keys(ocData.data.oc)[0];
        const firstStrikeData = ocData.data.oc[firstStrikeKey];
        const previous_close_price = firstStrikeData?.ce?.previous_close_price || firstStrikeData?.pe?.previous_close_price || spot_price;

        const df = Object.entries(ocData.data.oc).map(([strike, options]) => {
            const ce = options.ce || {}; const pe = options.pe || {};
            return {
                'Strike Price': parseFloat(strike),
                'CE Change': (ce.oi || 0) - (ce.previous_oi || 0), 'CE OI': ce.oi || 0, 'CE Volume': ce.volume || 0,
                'CE IV': ce.implied_volatility || 0, 'CE LTP': ce.last_price || 0,
                'PE OI': pe.oi || 0, 'PE Change': (pe.oi || 0) - (pe.previous_oi || 0), 'PE Volume': pe.volume || 0,
                'PE IV': pe.implied_volatility || 0, 'PE LTP': pe.last_price || 0,
            };
        }).sort((a, b) => a['Strike Price'] - b['Strike Price']);

        const peOI_ranks = getPercentileRanks(df.map(r => r['PE OI']));
        const peChange_ranks = getPercentileRanks(df.map(r => r['PE Change']));
        const peVolume_ranks = getPercentileRanks(df.map(r => r['PE Volume']));
        const ceOI_ranks = getPercentileRanks(df.map(r => r['CE OI']));
        const ceChange_ranks = getPercentileRanks(df.map(r => r['CE Change']));
        const ceVolume_ranks = getPercentileRanks(df.map(r => r['CE Volume']));

        df.forEach((row, i) => {
            row.Support_Score = peOI_ranks[i] + peChange_ranks[i] + peVolume_ranks[i];
            row.Resistance_Score = ceOI_ranks[i] + ceChange_ranks[i] + ceVolume_ranks[i];
        });

        const findMaxIndex = (key) => df.reduce((maxIndex, row, index, arr) => row[key] > arr[maxIndex][key] ? index : maxIndex, 0);

        const atmStrikeRow = df.reduce((prev, curr) => Math.abs(curr['Strike Price'] - spot_price) < Math.abs(prev['Strike Price'] - spot_price) ? curr : prev);

        const analytics = {
            spot: spot_price,
            previous_close: previous_close_price,
            pcr_oi: (df.reduce((s, r) => s + r['PE OI'], 0) / df.reduce((s, r) => s + r['CE OI'], 0)).toFixed(2),
            max_pain: calculateMaxPain(df),
            total_pe_change: df.reduce((s, r) => s + r['PE Change'], 0),
            total_ce_change: df.reduce((s, r) => s + r['CE Change'], 0),
            buy_call_level_simple: df[findMaxIndex('PE Change')]['Strike Price'],
            buy_put_level_simple: df[findMaxIndex('CE Change')]['Strike Price'],
            buy_call_level_scored: df[findMaxIndex('Support_Score')]['Strike Price'],
            buy_put_level_scored: df[findMaxIndex('Resistance_Score')]['Strike Price'],
            atm_iv: (atmStrikeRow['CE IV'] + atmStrikeRow['PE IV']) / 2,
            atm_straddle_price: atmStrikeRow['CE LTP'] + atmStrikeRow['PE LTP'],
        };

        analytics.call_conviction = calculateSignalConviction('call', analytics, df);
        analytics.put_conviction = calculateSignalConviction('put', analytics, df);

        // Asynchronously log the signals to Google Sheets without waiting
        if (analytics.call_conviction.strength === 'Strong' || analytics.put_conviction.strength === 'Strong') {
            const signalToLog = analytics.call_conviction.strength === 'Strong' ?
                { ...analytics.call_conviction, signal_type: 'Strong Call', signal_level: analytics.buy_call_level_scored, spot: analytics.spot } :
                { ...analytics.put_conviction, signal_type: 'Strong Put', signal_level: analytics.buy_put_level_scored, spot: analytics.spot };

            logToGoogleSheet({
                spot: signalToLog.spot,
                signal_type: signalToLog.signal_type,
                signal_level: signalToLog.signal_level,
                strength: signalToLog.strength,
                score: signalToLog.score,
                supporting: signalToLog.supporting.join(', '),
                contradicting: signalToLog.contradicting.join(', ')
            });
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ analytics, fullData: df }),
        };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};