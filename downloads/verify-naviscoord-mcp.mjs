import { spawn } from "node:child_process";
import readline from "node:readline";

const [exe, mode] = process.argv.slice(2);
if (!exe) throw new Error("Usage: node verify-naviscoord-mcp.mjs <exe> [--live]");

const child = spawn(exe, [], {
  env: { ...process.env, NAVISCOORD_READ_ONLY: "1" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let nextId = 1;
const pending = new Map();
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    for (const { reject } of pending.values()) reject(new Error(`Invalid JSON from server: ${line}`));
    pending.clear();
    return;
  }
  if (message.id != null && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}; stderr=${stderr.slice(-2000)}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "codex-naviscoord-verifier", version: "1.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const listed = await request("tools/list");
  const names = listed.tools.map((tool) => tool.name);
  const required = [
    "navis_health",
    "navis_analyze",
    "navis_snapshot",
    "navis_compare_snapshot",
    "navis_analysis_state",
  ];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`Missing required tools: ${missing.join(", ")}`);

  const outputPolicy = await request("tools/call", {
    name: "navis_output_policy",
    arguments: {},
  });
  if (outputPolicy.isError) throw new Error(`navis_output_policy failed: ${JSON.stringify(outputPolicy)}`);

  let health = null;
  if (mode === "--live") {
    health = await request("tools/call", { name: "navis_health", arguments: {} }, 60000);
    if (health.isError) throw new Error(`navis_health failed: ${JSON.stringify(health)}`);
  }

  console.log(JSON.stringify({
    server: initialized.serverInfo,
    protocolVersion: initialized.protocolVersion,
    tools: names.length,
    requiredTools: "passed",
    outputPolicy: "passed",
    readOnly: true,
    health,
  }, null, 2));
} finally {
  child.stdin.end();
  child.kill();
}
