import osc from "osc";

const IN_PORT = Number(process.env.MOCK_OSC_IN_PORT ?? 11000);
const OUT_PORT = Number(process.env.MOCK_OSC_OUT_PORT ?? 11001);

const port = new osc.UDPPort({
  localAddress: "127.0.0.1",
  localPort: IN_PORT,
  remoteAddress: "127.0.0.1",
  remotePort: OUT_PORT,
  metadata: true
});

function respond(address, args = []) {
  port.send({ address, args });
}

port.on("message", (msg) => {
  switch (msg.address) {
    case "/live/song/get/tempo":
      respond("/live/song/get/tempo", [{ type: "f", value: 120 }]);
      break;
    case "/live/song/get/num_tracks":
      respond("/live/song/get/num_tracks", [{ type: "i", value: 2 }]);
      break;
    case "/live/track/get/name": {
      const i = msg.args?.[0]?.value ?? 0;
      respond("/live/track/get/name", [
        { type: "i", value: i },
        { type: "s", value: i === 0 ? "Drums" : "Bass" }
      ]);
      break;
    }
    default:
      // No-op for unknown mock addresses.
      break;
  }
});

port.on("ready", () => {
  process.stdout.write(
    `Mock AbletonOSC listening on ${IN_PORT}, responding to ${OUT_PORT}\n`
  );
});

port.open();
