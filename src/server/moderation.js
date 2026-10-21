'use strict';
// OpenAI-compatible moderation endpoint; also accepts a policy gateway {decision,reason} response.
async function moderateText(word, { reviewMode = false } = {}) {
  const endpoint = process.env.MODERATION_URL;
  if (!endpoint) return { status: reviewMode ? 'pending' : 'approved', reason: reviewMode ? '房间开启人工预审' : '' };
  try {
    const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(Number(process.env.MODERATION_TIMEOUT_MS || 5000)),
      headers: { 'Content-Type': 'application/json', ...(process.env.MODERATION_API_KEY ? { Authorization: `Bearer ${process.env.MODERATION_API_KEY}` } : {}) },
      body: JSON.stringify({ input: word, model: process.env.MODERATION_MODEL || 'omni-moderation-latest' }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    if (value.decision && ['approved','pending','rejected'].includes(value.decision)) return { status: reviewMode && value.decision === 'approved' ? 'pending' : value.decision, reason: String(value.reason || '外部审核').slice(0, 500) };
    const result = value.results?.[0];
    if (typeof result?.flagged !== 'boolean') throw new Error('Malformed moderation response');
    return { status: result.flagged ? 'pending' : reviewMode ? 'pending' : 'approved', reason: result.flagged ? '语义审核标记，等待人工确认' : reviewMode ? '人工预审' : '语义审核通过' };
  } catch (error) {
    console.warn('Moderation unavailable:', error.message);
    return { status: 'pending', reason: '第三方审核暂不可用，已转人工审核（故障闭合）' };
  }
}
module.exports = { moderateText };
