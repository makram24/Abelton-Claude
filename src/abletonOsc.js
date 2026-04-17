import osc from "osc";

export class AbletonOscClient {
  constructor({ host, sendPort, listenPort, timeoutMs }) {
    this.host = host;
    this.sendPort = sendPort;
    this.listenPort = listenPort;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();

    this.udpPort = new osc.UDPPort({
      localAddress: "0.0.0.0",
      localPort: listenPort,
      remoteAddress: host,
      remotePort: sendPort,
      metadata: true
    });

    this.udpPort.on("message", (msg) => {
      const waiters = this.pending.get(msg.address);
      if (!waiters || waiters.length === 0) return;
      const waiter = waiters.shift();
      if (waiters.length === 0) this.pending.delete(msg.address);
      waiter.resolve(msg);
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.udpPort.off("ready", onReady);
        this.udpPort.off("error", onError);
      };

      this.udpPort.on("ready", onReady);
      this.udpPort.on("error", onError);
      this.udpPort.open();
    });
  }

  close() {
    try {
      this.udpPort.close();
    } catch {
      // no-op
    }
  }

  send(address, args = []) {
    this.udpPort.send({ address, args }, this.host, this.sendPort);
  }

  async request(address, args = [], responseAddress = address) {
    const messagePromise = new Promise((resolve, reject) => {
      let waiter;
      const timeout = setTimeout(() => {
        this._removeWaiter(responseAddress, waiter);
        reject(
          new Error(
            `Timeout waiting for OSC response "${responseAddress}". ` +
              `Check AbletonOSC port config and endpoint support.`
          )
        );
      }, this.timeoutMs);

      waiter = {
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        }
      };

      if (!this.pending.has(responseAddress)) {
        this.pending.set(responseAddress, []);
      }
      this.pending.get(responseAddress).push(waiter);
    });

    this.send(address, args);
    return messagePromise;
  }

  _removeWaiter(address, waiter) {
    const waiters = this.pending.get(address);
    if (!waiters) return;
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    if (waiters.length === 0) this.pending.delete(address);
  }
}

export function intArg(value) {
  return { type: "i", value };
}

export function floatArg(value) {
  return { type: "f", value };
}

export function stringArg(value) {
  return { type: "s", value };
}
