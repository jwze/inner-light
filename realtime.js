'use strict';
const { createClient } = require('redis');
const crypto = require('node:crypto');
function createBus(onEvent) {
  const instance = crypto.randomUUID();
  let publisher, subscriber, ready = false, closing = false;
  const channel = process.env.REDIS_CHANNEL || 'inner-light:events';
  async function start() {
    if (!process.env.REDIS_URL) return;
    publisher = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 3000, reconnectStrategy: (retries) => Math.min(3000, retries * 200) } });
    subscriber = publisher.duplicate();
    for (const c of [publisher, subscriber]) c.on('error', (error) => { ready = false; if (!closing) console.warn('Redis:', error.message); });
    publisher.on('ready', () => { ready = Boolean(subscriber?.isReady); });
    subscriber.on('ready', () => { ready = Boolean(publisher?.isReady); });
    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.subscribe(channel, (raw) => {
      try { const event = JSON.parse(raw); if (event.instance !== instance) onEvent(event.slug, event.payload); } catch (_) { /* ignore corrupt event */ }
    });
    ready = true;
  }
  start().catch((error) => console.warn('Redis startup:', error.message));
  return {
    send(slug, payload) {
      onEvent(slug, payload);
      if (ready) publisher.publish(channel, JSON.stringify({ instance, slug, payload })).catch((error) => console.warn('Redis publish:', error.message));
    },
    status() { return process.env.REDIS_URL ? (ready ? 'connected' : 'reconnecting') : 'disabled'; },
    async close() { closing = true; for (const c of [subscriber, publisher]) if (c?.isOpen) c.destroy(); }
  };
}
module.exports = { createBus };
