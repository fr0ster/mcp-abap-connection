/**
 * Generic WebSocket Transport Example
 *
 * Demonstrates how to plug a concrete WebSocket implementation
 * into GenericWebSocketTransport through the factory interface.
 */

const { GenericWebSocketTransport } = require('@mcp-abap-adt/connection');

class MockWebSocket {
  constructor() {
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }, 10);
  }

  send(payload) {
    // Echo payload back as "event" for demo purposes.
    if (this.onmessage) {
      this.onmessage({ data: payload });
    }
  }

  close(code, reason) {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose({
        code: code || 1000,
        reason: reason || 'normal',
        wasClean: true,
      });
    }
  }
}

const mockFactory = {
  create(_url, _protocols, _options) {
    return new MockWebSocket();
  },
};

async function main() {
  const transport = new GenericWebSocketTransport(mockFactory);

  transport.onOpen(() => {
    console.log('✓ WS open');
  });

  transport.onMessage((message) => {
    console.log('message:', message);
  });

  transport.onError((error) => {
    console.error('error:', error.message);
  });

  transport.onClose((info) => {
    console.log('closed:', info);
  });

  await transport.connect('wss://example.invalid/realtime', {
    connectTimeoutMs: 5000,
    heartbeatIntervalMs: 30000,
  });

  await transport.send({
    kind: 'request',
    correlationId: 'demo-1',
    operation: 'debugger.listen',
    payload: { timeoutSeconds: 30 },
    timestamp: Date.now(),
  });

  await transport.disconnect(1000, 'demo finished');
}

main().catch((error) => {
  console.error('Fatal:', error.message || String(error));
  process.exit(1);
});
