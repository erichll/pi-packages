// Synthetic worker: exercise the authenticated Runtime proxy without a model.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const instanceId = randomUUID();

async function probe(urls) {
  const proxy = new URL(process.env.HTTP_PROXY);
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  const results = [];
  for (const url of urls) {
    results.push(await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: proxy.hostname,
        port: proxy.port,
        path: url,
        headers: {
          Host: new URL(url).host,
          "Proxy-Authorization": `Basic ${Buffer.from(credentials).toString("base64")}`,
        },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (data) => { body += data; });
        response.on("end", () => resolve({ url, status: response.statusCode, body }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(5_000, () => request.destroy(new Error("proxy request timed out")));
      request.end();
    }));
  }
  return JSON.stringify({ instanceId, results });
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const assistant = (text) => send({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex < 0 ? undefined : process.argv[modeIndex + 1];
if (mode === "rpc") {
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line);
    send({ id: command.id, type: "response", success: true });
    if (command.type === "prompt" || command.type === "follow_up") {
      send({ type: "agent_start" });
      try {
        assistant(await probe(JSON.parse(command.message)));
      } catch (error) {
        assistant(JSON.stringify({ error: error.message }));
      }
      send({ type: "agent_settled" });
    }
  }
} else {
  const input = mode === "json"
    ? process.argv.at(-1).replace(/^Task: /, "")
    : process.argv[2];
  const text = await probe(JSON.parse(input));
  if (mode === "json") assistant(text);
  else process.stdout.write(text);
}
