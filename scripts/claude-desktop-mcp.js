/**
 * Claude Desktop stdio ↔ hosted Streamable HTTP bridge.
 *
 * Why not mcp-remote? That package always runs OAuth discovery. This server
 * advertises Entra Protected Resource Metadata, so mcp-remote tries a browser
 * OAuth flow (needs a verified custom domain we don't have yet) and dies —
 * which Claude Desktop surfaces as "write EPIPE".
 *
 * This bridge only attaches an Azure CLI bearer token and forwards MCP
 * JSON-RPC. No OAuth, no browser.
 *
 * Claude Desktop config should set cwd to this repo root so the MCP SDK
 * resolves from node_modules.
 *
 * Azure CLI discovery (in order):
 *   1. Official Windows MSI install (az.cmd under Microsoft SDKs\Azure\CLI2)
 *   2. `where az` / PATH
 *   3. Pip-installed az.bat — only if we can find a Python that imports azure.cli
 *      (Claude Desktop's PATH often prefers a different Python than az.bat expects)
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");

// Deployment-specific values come from the environment (set them in the
// "env" block of the Claude Desktop MCP server entry) rather than being
// hardcoded, so no tenant/app/host identifiers live in source control.
const API_CLIENT_ID = process.env.MCP_API_CLIENT_ID;
const TENANT_ID = process.env.MCP_TENANT_ID;
const MCP_URL = process.env.MCP_URL;
if (!API_CLIENT_ID || !TENANT_ID || !MCP_URL) {
  // stderr only - stdout is reserved for the MCP stdio protocol
  process.stderr.write(
    "Set MCP_API_CLIENT_ID, MCP_TENANT_ID and MCP_URL (e.g. https://<app>.<region>.azurecontainerapps.io/mcp)." + "\n",
  );
  process.exit(1);
}
const SCOPE = `api://${API_CLIENT_ID}/.default`;

const LOGIN_HINT =
  `az login --tenant ${TENANT_ID} --scope "${SCOPE}"`;

function fail(msg) {
  // stderr only — stdout is reserved for the MCP stdio protocol
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function pythonHasAzureCli(pythonPath) {
  const r = spawnSync(pythonPath, ["-c", "import azure.cli"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return r.status === 0;
}

function findPythonWithAzureCli() {
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    String.raw`C:\Python314\python.exe`,
    String.raw`C:\Python313\python.exe`,
    String.raw`C:\Python312\python.exe`,
    path.join(local, "Programs", "Python", "Python314", "python.exe"),
    path.join(local, "Programs", "Python", "Python313", "python.exe"),
    path.join(local, "Programs", "Python", "Python312", "python.exe"),
  ];
  for (const py of candidates) {
    if (exists(py) && pythonHasAzureCli(py)) return py;
  }
  return null;
}

/**
 * @returns {{ mode: 'az-cmd', command: string, argsPrefix: string[] }
 *         | { mode: 'python-module', python: string, scriptsSrc?: string }}
 */
function resolveAzRunner() {
  const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] || String.raw`C:\Program Files (x86)`;

  // 1) Official MSI — self-contained, ignores whichever python is on PATH.
  const msiCandidates = [
    path.join(programFiles, "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd"),
    path.join(programFilesX86, "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd"),
  ];
  for (const cmd of msiCandidates) {
    if (exists(cmd)) {
      return { mode: "az-cmd", command: cmd, argsPrefix: [] };
    }
  }

  // 2) Whatever `where az` finds (PATH). Prefer .cmd over .bat when both appear.
  const where = spawnSync("where.exe", ["az"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (where.status === 0) {
    const hits = (where.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const cmdHit = hits.find((h) => /\.cmd$/i.test(h));
    const batHit = hits.find((h) => /\.bat$/i.test(h));
    if (cmdHit && exists(cmdHit)) {
      return { mode: "az-cmd", command: cmdHit, argsPrefix: [] };
    }
    // Pip az.bat: don't trust PATH's python — find one that has azure.cli.
    if (batHit && exists(batHit)) {
      const py = findPythonWithAzureCli();
      if (py) {
        const scriptsDir = path.dirname(batHit);
        const scriptsSrc = path.join(scriptsDir, "src");
        return {
          mode: "python-module",
          python: py,
          scriptsSrc: exists(scriptsSrc) ? scriptsSrc : undefined,
        };
      }
      fail(
        "Found a pip-installed Azure CLI (az.bat), but no Python with the azure.cli module.\n" +
          "Easiest fix: install the official Azure CLI MSI from https://aka.ms/installazurecliwindows\n" +
          `Then run: ${LOGIN_HINT}`,
      );
    }
  }

  // 3) Last resort: python -m azure.cli on a discovered interpreter.
  const py = findPythonWithAzureCli();
  if (py) {
    return { mode: "python-module", python: py };
  }

  fail(
    "Could not find Azure CLI.\n" +
      "Install it from https://aka.ms/installazurecliwindows then run:\n" +
      `  ${LOGIN_HINT}`,
  );
}

function getAccessToken() {
  const runner = resolveAzRunner();
  const tokenArgs = [
    "account",
    "get-access-token",
    "--scope",
    SCOPE,
    "--query",
    "accessToken",
    "-o",
    "tsv",
  ];

  let result;
  if (runner.mode === "az-cmd") {
    // shell:true so .cmd files run; command path may contain spaces (Program Files).
    result = spawnSync(runner.command, tokenArgs, {
      encoding: "utf8",
      windowsHide: true,
      shell: true,
    });
  } else {
    const env = { ...process.env };
    if (runner.scriptsSrc) {
      env.PYTHONPATH = `${runner.scriptsSrc}${path.delimiter}${env.PYTHONPATH || ""}`;
      env.AZ_INSTALLER = "PIP";
    }
    result = spawnSync(
      runner.python,
      ["-m", "azure.cli", ...tokenArgs],
      { encoding: "utf8", windowsHide: true, env },
    );
  }

  if (result.status !== 0) {
    fail(
      "Failed to get Entra access token.\n" +
        `stderr: ${(result.stderr || "").trim()}\n` +
        `Run: ${LOGIN_HINT}`,
    );
  }
  const token = (result.stdout || "").trim();
  if (!token) fail("Azure CLI returned an empty access token.");
  return token;
}

function bridge(local, remote) {
  local.onmessage = (message) => {
    remote.send(message).catch((err) => {
      process.stderr.write(`remote send failed: ${err}\n`);
    });
  };
  remote.onmessage = (message) => {
    local.send(message).catch((err) => {
      process.stderr.write(`local send failed: ${err}\n`);
    });
  };
  local.onclose = () => {
    remote.close().catch(() => {});
  };
  remote.onclose = () => {
    local.close().catch(() => {});
  };
  local.onerror = (err) => process.stderr.write(`local transport error: ${err}\n`);
  remote.onerror = (err) => process.stderr.write(`remote transport error: ${err}\n`);
}

async function main() {
  const token = getAccessToken();

  const remote = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const local = new StdioServerTransport();
  bridge(local, remote);

  await remote.start();
  await local.start();
  process.stderr.write("entra-iam-review-hosted: stdio bridge connected\n");
}

main().catch((err) => fail(String(err && err.stack ? err.stack : err)));
