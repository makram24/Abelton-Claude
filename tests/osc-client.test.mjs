import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { AbletonOscClient, intArg } from "../src/abletonOsc.js";
import { parseOscValue } from "../src/lib/oscParse.js";
import osc from "osc";

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

test("AbletonOscClient request/response against mock OSC", async () => {
  const sendPort = await freePort();
  const listenPort = await freePort();

  const mock = new osc.UDPPort({
    localAddress: "127.0.0.1",
    localPort: sendPort,
    remoteAddress: "127.0.0.1",
    remotePort: listenPort,
    metadata: true
  });

  await new Promise((resolve, reject) => {
    mock.on("ready", resolve);
    mock.on("error", reject);
    mock.open();
  });

  mock.on("message", (msg) => {
    if (msg.address === "/live/song/get/tempo") {
      mock.send({ address: "/live/song/get/tempo", args: [{ type: "f", value: 128 }] });
    }
    if (msg.address === "/live/track/get/name") {
      const i = msg.args?.[0]?.value ?? 0;
      mock.send({
        address: "/live/track/get/name",
        args: [
          { type: "i", value: i },
          { type: "s", value: "Drums" }
        ]
      });
    }
  });

  const client = new AbletonOscClient({
    host: "127.0.0.1",
    sendPort,
    listenPort,
    timeoutMs: 2000
  });
  await client.open();

  try {
    const tempoMsg = await client.request("/live/song/get/tempo");
    assert.equal(parseOscValue(tempoMsg), 128);

    const nameMsg = await client.request("/live/track/get/name", [intArg(0)]);
    assert.deepEqual(parseOscValue(nameMsg), [0, "Drums"]);
  } finally {
    client.close();
    mock.close();
  }
});
